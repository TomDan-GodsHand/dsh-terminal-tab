/**
 * Plugin smoke checks, run in one process with `node test/smoke.mjs`.
 *
 * The checks exercise the real modules — the browser half through its built
 * bundle, the host half through its source — with a fake PTY and a fake socket,
 * so the protocol, the trust fence, and the slot registration are verified
 * without a terminal or a browser. A real ConPTY cannot be created here: the
 * agent sandbox refuses the named pipe it needs.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

let checks = 0
const failures = []

/** Run one named check, recording a failure instead of aborting the run. */
function check(name, body) {
  checks += 1
  try {
    body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

/** A socket stand-in recording what the host sent. */
class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent = []
  closed = null

  send(data) {
    this.sent.push(data)
  }

  close(code, reason) {
    this.closed = { code, reason }
    this.readyState = 3
  }
}

/** A PTY stand-in recording writes and exposing its data/exit emitters. */
function fakePty() {
  const listeners = { data: [], exit: [] }
  const pty = {
    written: [],
    write: (data) => {
      pty.written.push(data)
    },
    onData: (callback) => {
      listeners.data.push(callback)
      return { dispose: () => {} }
    },
    onExit: (callback) => {
      listeners.exit.push(callback)
      return { dispose: () => {} }
    },
    emitData: (data) => {
      for (const callback of listeners.data) callback(data)
    },
    emitExit: (exitCode) => {
      for (const callback of listeners.exit) callback({ exitCode })
    },
  }
  return pty
}

/** A terminal registry stand-in recording lifecycle calls. */
function fakeManager(handle) {
  return {
    calls: [],
    open(sessionId, tabId, cwd, cols, rows) {
      this.calls.push({ name: 'open', sessionId, tabId, cwd, cols, rows })
      return handle
    },
    resize(_handle, cols, rows) {
      this.calls.push({ name: 'resize', cols, rows })
      return true
    },
    scheduleClose(key, delayMs) {
      this.calls.push({ name: 'scheduleClose', key, delayMs })
    },
    park(key) {
      this.calls.push({ name: 'park', key })
    },
    isParked() {
      return false
    },
  }
}

const { parseControl } = await import('../src/wire.ts')
const { attachTerminal, PTY_DEPS_MISSING } = await import('../src/terminal.ts')
const { clampDimension, resolveProgram, resolveShell, resolveExecutable } = await import('../src/pty.ts')
const { isTrustedRequest, isLoopbackHostname } = await import('../src/trust-fence.ts')
const { resolveConfig } = await import('../src/config.ts')
const { apply: applyHost, TERMINAL_WS_PATH, DIAGNOSTICS_PATH } = await import('../src/index.ts')
const { TerminalSettingsSchema } = await import('../src/settings.ts')
const {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  FONT_SIZE_MAX,
  parseHexColor,
  readSettings,
} = await import('../src/shared.ts')

// ---------------------------------------------------------------- wire frames

check('a plain keystroke is terminal input', () => {
  assert.equal(parseControl('a'), null)
  assert.equal(parseControl('ls -la\r'), null)
})

check('an unrecognized JSON frame is terminal input', () => {
  assert.equal(parseControl('{"type":"nope"}'), null)
  assert.equal(parseControl('{"other":1}'), null)
  assert.equal(parseControl('{ not json'), null)
  assert.equal(parseControl('[1,2]'), null)
})

check('a resize frame needs numeric dimensions', () => {
  assert.deepEqual(parseControl('{"type":"resize","cols":120,"rows":40}'), { type: 'resize', cols: 120, rows: 40 })
  assert.equal(parseControl('{"type":"resize","cols":"120","rows":40}'), null)
  assert.equal(parseControl('{"type":"resize","cols":1}'), null)
})

check('close and park frames are recognized', () => {
  assert.deepEqual(parseControl('{"type":"close"}'), { type: 'close' })
  assert.deepEqual(parseControl('{"type":"park"}'), { type: 'park' })
})

// --------------------------------------------------------------- pty helpers

check('dimensions are clamped into the terminal range', () => {
  assert.equal(clampDimension(120, 80), 120)
  assert.equal(clampDimension(0, 80), 2)
  assert.equal(clampDimension(99999, 80), 1024)
  assert.equal(clampDimension(Number.NaN, 80), 80)
  assert.equal(clampDimension(40.7, 80), 40)
})

check('a configured command wins over the shell', () => {
  const program = resolveProgram(
    { command: 'nvim', commandArgs: ['-p'], shell: '', shellArgs: [] },
    'linux',
    {},
  )
  assert.deepEqual(program, { file: 'nvim', args: ['-p'] })
})

check('the POSIX shell defaults to a login shell', () => {
  assert.deepEqual(
    resolveProgram({ command: '', commandArgs: [], shell: '', shellArgs: [] }, 'linux', {}),
    { file: '/bin/bash', args: ['-l'] },
  )
  assert.equal(resolveShell('', 'linux', { SHELL: '/bin/zsh' }), '/bin/zsh')
  assert.equal(resolveShell('/bin/fish', 'linux', { SHELL: '/bin/zsh' }), '/bin/fish')
})

check('explicit shell arguments replace the platform default', () => {
  assert.deepEqual(
    resolveProgram({ command: '', commandArgs: [], shell: 'zsh', shellArgs: ['--no-rc'] }, 'linux', {}),
    { file: 'zsh', args: ['--no-rc'] },
  )
})

check('the Windows shell falls back to the inbox PowerShell', () => {
  assert.equal(resolveShell('', 'win32', {}), 'powershell.exe')
  assert.equal(resolveShell('', 'win32', { DSH_TERMINAL_TAB_SHELL: 'C:\\bin\\nu.exe' }), 'C:\\bin\\nu.exe')
  assert.deepEqual(
    resolveProgram({ command: '', commandArgs: [], shell: '', shellArgs: [] }, 'win32', {}),
    { file: 'powershell.exe', args: [] },
  )
})

check('a bare Windows program name is expanded through PATH and PATHEXT', () => {
  // The resolver consults the filesystem, so the fixture is a real directory with
  // a real file. Hardcoding a path such as `C:\Program Files\Neovim\bin` passes
  // only on a machine that happens to have Neovim installed — which is exactly
  // how this check failed on the Linux CI runner the first time it ran.
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-tab-path-'))
  try {
    const bin = join(root, 'Neovim', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'nvim.exe'), '')
    const found = resolveExecutable('nvim', 'win32', {
      // A first, missing directory proves the search continues past a miss.
      PATH: [join(root, 'missing'), bin].join(';'),
      PATHEXT: '.COM;.EXE',
    })
    assert.equal(found, join(bin, 'nvim.exe'))
    // A name no directory holds stays as written.
    assert.equal(resolveExecutable('definitely-absent-xyz', 'win32', { PATH: root, PATHEXT: '.EXE' }), 'definitely-absent-xyz')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // A path is taken as written, and non-Windows platforms pass the name through.
  assert.equal(resolveExecutable('C:\\tools\\nvim.exe', 'win32', {}), 'C:\\tools\\nvim.exe')
  assert.equal(resolveExecutable('nvim', 'linux', {}), 'nvim')
})

// ------------------------------------------------------------------ fence

check('loopback hostnames are recognized', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.1.2.3'), true)
  assert.equal(isLoopbackHostname('127.0.0.1.example.com'), false)
  assert.equal(isLoopbackHostname('192.168.1.5'), false)
  assert.equal(isLoopbackHostname('[::1]'), true)
})

check('a loopback request with no browser markers passes', () => {
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } }, []), true)
})

check('a remote host is refused unless it is trusted', () => {
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example:3080' } }, []), false)
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example:3080' } }, ['evil.example:3080']), true)
  assert.equal(isTrustedRequest({ headers: {} }, []), false)
})

check('cross-site and foreign-origin requests are refused', () => {
  assert.equal(isTrustedRequest({
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  }, []), false)
  assert.equal(isTrustedRequest({
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  }, []), false)
  assert.equal(isTrustedRequest({
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }, []), true)
  assert.equal(isTrustedRequest({
    headers: { host: '127.0.0.1:3080', origin: 'null' },
  }, []), false)
})

// -------------------------------------------------------------- host half

check('the host half registers its namespace, its route, and its diagnostic', () => {
  const registrations = []
  const upgrades = []
  const httpRoutes = []
  const scope = { get: () => ({ shell: 'cmd', command: 'nvim' }) }
  const effects = []
  const entry = { id: 'dsh-terminal-tab', url: '/plugins/??dsh-terminal-tab/client.js&rev=abc', rev: 'abc' }
  const batch = { phase: 'application', url: entry.url, rev: 'abc', entries: ['dsh-terminal-tab'] }
  const clientModules = {
    clientPath: (id) => (id === 'dsh-terminal-tab' ? 'C:/x/lib/client.js' : undefined),
    graph: () => ({ rev: 'graph-rev', entries: [entry], batches: [batch] }),
  }
  applyHost({
    inject(deps, callback) {
      // Only the settings capability is injected; the client graph is read
      // through an optional ctx.get so the diagnostic never hides behind a
      // service.
      assert.deepEqual([...deps], ['settings'])
      callback({
        settings: {
          register(ns, schema, options) {
            registrations.push({ ns, schema, options })
            return scope
          },
        },
      })
    },
    get: (name) => (name === 'clientModules' ? clientModules : undefined),
    effect(factory, label) {
      effects.push(label)
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: {
      registerUpgrade(route) {
        upgrades.push(route)
        return () => {}
      },
      register(route) {
        httpRoutes.push(route)
        return () => {}
      },
    },
  })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].ns, 'dsh-terminal-tab')
  // The composition row is the base layer, so the settings page shows it as the
  // inherited value rather than as an empty field.
  assert.equal(registrations[0].options.base.shell, 'auto')
  assert.equal(registrations[0].options.base.command, '')
  assert.notEqual(registrations[0].schema, undefined)

  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].path, TERMINAL_WS_PATH)
  assert.equal(typeof upgrades[0].handler, 'function')

  // The diagnostic answers "is my browser row in the graph?" without a browser.
  assert.equal(httpRoutes.length, 1)
  assert.equal(httpRoutes[0].path, DIAGNOSTICS_PATH)
  const response = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  httpRoutes[0].handler({ headers: { host: '127.0.0.1:3080' } }, response)
  assert.equal(response.status, 200)
  const reported = JSON.parse(response.body)
  assert.equal(reported.clientModules, true)
  assert.equal(reported.clientPath, 'C:/x/lib/client.js')
  assert.equal(reported.row.id, 'dsh-terminal-tab')
  assert.equal(reported.batch.url, entry.url)
  assert.equal(reported.entryCount, 1)
  // The self-check reports which copy of the bundle this process loaded.
  assert.match(reported.loadedHash, /^[0-9a-f]{12}$/)
  assert.equal(reported.stale, false)

  // The same route refuses a foreign authority.
  const refused = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end() {},
  }
  httpRoutes[0].handler({ headers: { host: 'evil.example' } }, refused)
  assert.equal(refused.status, 403)
})

check('the settings namespace is exposed as a usable schema', () => {
  // The settings service serializes the schema for the browser and resolves a
  // stored section through it, so the schema itself must be exercisable here —
  // registering it is the one host step the stubbed check above cannot reach.
  const json = TerminalSettingsSchema.toJSON()
  assert.equal(typeof json, 'object')

  const resolved = TerminalSettingsSchema({})
  assert.equal(resolved.shell, 'auto')
  assert.equal(resolved.command, '')
  assert.equal(resolved.fontSize, DEFAULT_FONT_SIZE)
  assert.equal(resolved.theme.background, DEFAULT_THEME.background)
  assert.equal(resolved.theme.white, DEFAULT_THEME.white)

  const stored = TerminalSettingsSchema({ shell: 'cmd', fontSize: 18, theme: { red: '#ff0000' } })
  assert.equal(stored.shell, 'cmd')
  assert.equal(stored.fontSize, 18)
  assert.equal(stored.theme.red, '#ff0000')
  assert.equal(stored.theme.green, DEFAULT_THEME.green)

  // Out-of-range values are refused rather than stored, so the settings page
  // cannot persist a font size xterm would reject.
  assert.throws(() => TerminalSettingsSchema({ fontSize: 999 }))
})

// ------------------------------------------------------------- configuration

check('configuration defaults are applied', () => {
  const resolved = resolveConfig()
  assert.equal(resolved.command, '')
  assert.equal(resolved.maxPerSession, 3)
  assert.equal(resolved.reconnectGraceMs, 30_000)
  assert.equal(resolved.cwd, process.cwd())
  const overridden = resolveConfig({ command: 'nvim', maxPerSession: 1, reconnectGraceMs: 0 })
  assert.equal(overridden.command, 'nvim')
  assert.equal(overridden.maxPerSession, 1)
  assert.equal(overridden.reconnectGraceMs, 0)
})

// ---------------------------------------------------------- socket protocol

/** Attach one fake socket and return the recorded pieces. */
function attach({ url = '/terminal-tab/ws?sessionId=s1&tab=main', manager, transcript = '' }) {
  const socket = new FakeSocket()
  const pty = fakePty()
  const handle = { key: 's1:main', pty, transcript, exited: false, cwd: 'D:\\repos', sessionId: 's1', tabId: 'main' }
  const registry = manager ?? fakeManager(handle)
  attachTerminal({
    socket,
    request: { url },
    manager: registry,
    defaultCwd: 'D:\\repos',
    reconnectGraceMs: 30_000,
  })
  return { socket, pty, handle, registry }
}

check('a request without a session is refused', () => {
  const { socket } = attach({ url: '/terminal-tab/ws' })
  assert.deepEqual(socket.closed, { code: 1008, reason: 'sessionId is required' })
})

check('a deployment without node-pty answers pty-deps-missing', () => {
  const socket = new FakeSocket()
  attachTerminal({
    socket,
    request: { url: '/terminal-tab/ws?sessionId=s1' },
    manager: null,
    defaultCwd: 'D:\\repos',
    reconnectGraceMs: 30_000,
  })
  assert.equal(socket.closed.code, 1011)
  assert.equal(socket.closed.reason, PTY_DEPS_MISSING)
})

check('the terminal opens for the requested session and tab', () => {
  const { registry } = attach({ url: '/terminal-tab/ws?sessionId=s9&tab=two&cols=100&rows=30' })
  const opened = registry.calls.find(call => call.name === 'open')
  assert.equal(opened.sessionId, 's9')
  assert.equal(opened.tabId, 'two')
  assert.equal(opened.cols, 100)
  assert.equal(opened.rows, 30)
})

check('buffered output is replayed before live output', () => {
  const { socket, pty } = attach({ transcript: 'earlier\r\n' })
  assert.deepEqual(socket.sent, ['earlier\r\n'])
  pty.emitData('now')
  assert.deepEqual(socket.sent, ['earlier\r\n', 'now'])
})

check('process exit is reported in the stream', () => {
  const { socket, pty } = attach({})
  pty.emitExit(7)
  assert.match(socket.sent.at(-1), /进程已退出，代码 7/)
})

check('keystrokes reach the process and control frames do not', () => {
  const { socket, pty } = attach({})
  socket.emit('message', Buffer.from('ls\r'))
  socket.emit('message', Buffer.from('{"type":"close"}'))
  assert.deepEqual(pty.written, ['ls\r'])
})

check('a resize frame resizes the terminal', () => {
  const { socket, registry } = attach({})
  socket.emit('message', Buffer.from('{"type":"resize","cols":132,"rows":43}'))
  const resized = registry.calls.find(call => call.name === 'resize')
  assert.deepEqual([resized.cols, resized.rows], [132, 43])
})

check('close and park frames drive the terminal lifecycle', () => {
  const closed = attach({})
  closed.socket.emit('message', Buffer.from('{"type":"close"}'))
  assert.deepEqual(closed.registry.calls.at(-1), { name: 'scheduleClose', key: 's1:main', delayMs: 0 })

  const parked = attach({})
  parked.socket.emit('message', Buffer.from('{"type":"park"}'))
  assert.deepEqual(parked.registry.calls.at(-1), { name: 'park', key: 's1:main' })
})

check('a disconnect schedules the grace-period close', () => {
  const { socket, registry } = attach({})
  socket.emit('close')
  assert.deepEqual(registry.calls.at(-1), { name: 'scheduleClose', key: 's1:main', delayMs: 30_000 })
})

// -------------------------------------------------------- settings payloads

check('a settings payload is normalized at the wire boundary', () => {
  const decoded = readSettings({
    shell: 'cmd',
    command: 'nvim',
    fontSize: 99,
    theme: { red: '#123456', background: '', unknown: '#ffffff' },
  })
  assert.equal(decoded.shell, 'cmd')
  assert.equal(decoded.command, 'nvim')
  // Out of range is clamped, and an empty string falls back to the default.
  assert.equal(decoded.fontSize, FONT_SIZE_MAX)
  assert.equal(decoded.theme.red, '#123456')
  assert.equal(decoded.theme.background, DEFAULT_THEME.background)
  // An unusable payload yields the defaults rather than reaching xterm.
  assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(readSettings({ theme: 'nope', fontSize: 'big' }), DEFAULT_SETTINGS)
})

check('a font stack is normalized at the wire boundary', () => {
  assert.equal(readSettings({}).fontFamily, DEFAULT_FONT_FAMILY)
  // Whitespace is not a font stack, and neither is a missing field.
  assert.equal(readSettings({ fontFamily: '   ' }).fontFamily, DEFAULT_FONT_FAMILY)
  assert.equal(readSettings({ fontFamily: 42 }).fontFamily, DEFAULT_FONT_FAMILY)
  // Anything else is taken as written: the browser resolves the list.
  assert.equal(readSettings({ fontFamily: " 'X Mono', monospace " }).fontFamily, "'X Mono', monospace")
})

check('a typed colour is read in every form a hex code is written', () => {
  assert.equal(parseHexColor('#aabbcc'), '#aabbcc')
  assert.equal(parseHexColor('AABBCC'), '#aabbcc')
  assert.equal(parseHexColor('aabbcc'), '#aabbcc')
  assert.equal(parseHexColor(' #abc '), '#aabbcc')
  assert.equal(parseHexColor('#F0f'), '#ff00ff')
  // Anything less than a colour is not one, so it can never be staged.
  assert.equal(parseHexColor(''), undefined)
  assert.equal(parseHexColor('#ab'), undefined)
  assert.equal(parseHexColor('#aabbc'), undefined)
  assert.equal(parseHexColor('#gggggg'), undefined)
  assert.equal(parseHexColor('red'), undefined)
})

// ------------------------------------------------------------------ shell choice

check('the shell setting resolves every keyword', () => {
  const env = { SHELL: '/bin/zsh' }
  assert.equal(resolveShell('', 'linux', env), '/bin/zsh')
  assert.equal(resolveShell('auto', 'linux', {}), '/bin/bash')
  // Windows auto-discovery prefers PowerShell 7 and falls back to the inbox
  // host; which one stands depends on the machine, so assert the intent.
  const autoWindows = resolveShell('auto', 'win32', {})
  assert.ok(
    autoWindows === 'powershell.exe' || autoWindows.toLowerCase().endsWith('pwsh.exe'),
    `unexpected auto shell: ${autoWindows}`,
  )
  // A first-choice environment variable short-circuits discovery.
  assert.equal(resolveShell('auto', 'win32', { DSH_TERMINAL_TAB_SHELL: 'C:\\bin\\nu.exe' }), 'C:\\bin\\nu.exe')
  assert.equal(resolveShell('powershell', 'win32', {}), 'powershell.exe')
  assert.equal(resolveShell('cmd', 'win32', {}), 'cmd.exe')
  assert.equal(resolveShell('bash', 'linux', {}), 'bash')
  // Anything else is taken as written: a path or a name from PATH.
  assert.equal(resolveShell('C:\\tools\\nu.exe', 'win32', {}), 'C:\\tools\\nu.exe')
  assert.equal(resolveShell('nu', 'linux', {}), 'nu')
})

check('a keyword shell also drives the spawned program', () => {
  assert.deepEqual(
    resolveProgram({ command: '', commandArgs: [], shell: 'cmd', shellArgs: [] }, 'win32', {}),
    { file: 'cmd.exe', args: [] },
  )
})

// -------------------------------------------------------------- client half

/** Evaluate the built client bundle and return its module plus the loader entry. */
function loadClientBundle() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  // xterm reads browser globals while its module body evaluates, so the sandbox
  // stands in for the page the bundle is really loaded into.
  const sandbox = {
    navigator: { userAgent: 'dsh-terminal-tab-test', platform: 'Win32', language: 'en-US' },
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { loaded, sandbox }
}

/**
 * The module table this plugin may ask for, with a stub for every shell-seeded
 * value it takes. Anything else fails the same way it would at boot, which is
 * what makes the strict-require checks meaningful.
 */
const BASELINE_MODULES = {
  'react': () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
  // Shell-seeded UI library: the card's chevron and staged-edit tag come from here.
  '@deepseek-ai/dsh-client-ui-primitives': () => ({
    IconChevronDownOutline14: () => null,
    Tag: () => null,
  }),
}

/** Resolve one module request against the baseline, or fail loudly. */
function clientRequire(specifier) {
  const load = BASELINE_MODULES[specifier]
  if (load === undefined) throw new Error(`unexpected module request: ${specifier}`)
  return load()
}

check('the client bundle asks the module table only for the shared baseline', () => {
  const { loaded } = loadClientBundle()
  assert.equal(loaded.id, 'dsh-terminal-tab')
  assert.equal(typeof loaded.factory, 'function')
  loaded.factory(clientRequire)
})

check('the terminal view hides the resident composer and its width handles', () => {
  // The composer belongs to the conversation shell, and its chain selector only
  // sees session business state — never which view is active. The view's own
  // presence is that signal, so the rule keys on it plus the shell's own hooks
  // (`data-composer-seat`, `data-width-handle`), not on any hashed class name.
  // The handles are siblings of the seat and must be hidden with it: their
  // position comes from the chat column width the composer no longer has, so
  // leaving them shows two drag strips straddling the terminal.
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The stylesheet rides the bundle as a JS string literal, so its line breaks
  // are the two characters `\` `n`; uncover them before matching whitespace.
  const css = code.replace(/\\n/g, '\n')
  const rule = /body:has\(\.dshTerminalTabRoot\)\s*\[data-composer-seat\],\s*body:has\(\.dshTerminalTabRoot\)\s*\[data-width-handle\]\s*\{[^}]*display:\s*none/
  assert.match(css, rule)
})

check('every bound settings hook is called with a selector', () => {
  // The renderer binds an inject `hooks` entry by forwarding the bound hook's
  // argument straight to useSyncExternalStoreWithSelector, which calls it: an
  // argument-less call becomes `undefined` there and crashes the whole slot
  // entry at render. This regressed once (both entries crashed with
  // "TypeError: l is not a function"), so the artifact is checked for it. Bound
  // hook prop names survive minification because the renderer resolves them by
  // name, which is what makes the check meaningful.
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.deepEqual([...code.matchAll(/useSettings\(\s*\)/g)], [])
  assert.match(code, /useSettings\(/)
})

check('the browser half registers the 终端 tab and its settings card', () => {
  const { loaded } = loadClientBundle()
  const mod = loaded.factory(clientRequire)
  assert.equal(typeof mod.apply, 'function')
  // Copy out of the sandbox realm: deepStrictEqual compares array prototypes.
  assert.deepEqual([...mod.inject], ['slots', 'settingsScope'])

  const registrations = []
  const injected = []
  const bound = []
  const writes = []
  // What the Host currently resolves; the card's write is a diff against this.
  const accepted = {
    shell: 'pwsh',
    command: '',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 14,
    theme: { ...DEFAULT_THEME },
  }
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: accepted,
      base: undefined,
      user: undefined,
      revision: 3,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: () => Promise.resolve(),
    unset: () => Promise.resolve(),
    mutate: (ops) => {
      writes.push(ops)
      return Promise.resolve()
    },
  }
  mod.apply({
    settingsScope: {
      bind(spec) {
        bound.push(spec)
        return scope
      },
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(injected, ['conversation.view', 'settings.plugin.item'])
  assert.equal(registrations.length, 2)

  const view = registrations.find(entry => entry.options.name === 'conversation.view')
  assert.equal(view.options.id, 'terminal')
  assert.equal(view.options.order, 20)
  assert.equal(view.options.label(), '终端')
  assert.equal(typeof view.component, 'function')

  const card = registrations.find(entry => entry.options.name === 'settings.plugin.item')
  // The key IS the pairing with the host namespace.
  assert.equal(card.options.key, 'dsh-terminal-tab')
  assert.equal(typeof card.component, 'function')

  // One scope, bound once, under the namespace the host registers.
  assert.equal(bound.length, 1)
  assert.equal(bound[0].namespace, 'dsh-terminal-tab')
  const decoded = bound[0].decode({ fontSize: 99, theme: { red: '#101010' } })
  assert.equal(decoded.fontSize, FONT_SIZE_MAX)
  assert.equal(decoded.theme.red, '#101010')
  assert.equal(decoded.theme.cyan, DEFAULT_THEME.cyan)

  // Both entries read the same scope; only the card's face also writes.
  assert.equal(view.options.inject().hooks.settings, scope)
  const face = card.options.inject()
  assert.equal(face.hooks.settings, scope)

  // A staged edit writes only what differs from what the Host already resolves.
  void face.apply({ ...accepted, fontSize: 18 }, false)
  assert.equal(
    JSON.stringify(writes),
    JSON.stringify([[{ op: 'set', path: ['fontSize'], value: 18 }]]),
  )

  // A staged restore clears the root first, then re-applies what still differs.
  void face.apply({ ...DEFAULT_SETTINGS, theme: { ...DEFAULT_THEME, red: '#ff0000' } }, true)
  assert.equal(
    JSON.stringify(writes[1]),
    JSON.stringify([
      { op: 'unset', path: [] },
      { op: 'set', path: ['theme', 'red'], value: '#ff0000' },
    ]),
  )

  // Saving an unchanged form writes nothing at all.
  void face.apply(accepted, false)
  assert.equal(writes.length, 2)
})

// ------------------------------------------------------------------- report

console.log(`\n${String(checks - failures.length)}/${String(checks)} checks passed`)
if (failures.length > 0) {
  console.error('\nFailures:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
