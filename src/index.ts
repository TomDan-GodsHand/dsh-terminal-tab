/**
 * dsh-terminal-tab — host half.
 *
 * Provides the terminal process behind the browser's 终端 tab, and owns the
 * settings namespace that the 插件设置 page edits. The plugin owns exactly one
 * route, a WebSocket upgrade carrying raw terminal bytes; the browser half
 * registers the tab and the settings card itself.
 *
 * The route is reachable without the page's authentication token, because a
 * registered route is dispatched before the GUI's authenticated fallback, so
 * every upgrade passes the loopback/cross-site trust fence before it may open a
 * terminal.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merge that declares ctx.webServer.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the Context merge that declares ctx.clientModules.
import type {} from '@deepseek-ai/dsh-client-modules'
// Type-only: pulls the Context merge that declares ctx.settings.
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { resolveConfig, type TerminalTabConfig } from './config.ts'
import { loadNodePty, PtyManager, resolveProgram } from './pty.ts'
import { SETTINGS_NS, TerminalSettingsSchema, type TerminalSettings } from './settings.ts'
import { SHELL_AUTO } from './shared.ts'
import { attachTerminal } from './terminal.ts'
import { isTrustedRequest } from './trust-fence.ts'

/** Plugin name; also the loader row name the bundle patch inserts. */
export const name = 'dsh-terminal-tab'

/** The package name, which is also this plugin's row id in the client graph. */
const PACKAGE = 'dsh-terminal-tab'

/**
 * Content hash of this bundle, captured when the process imported it.
 *
 * Comparing it with the file's current hash is how a stale process is detected:
 * copying a new `lib/` over an installed one does not make a running server
 * re-import the module, and nothing else about the process reveals which copy of
 * the code it is executing. The hash is content, not modification time —
 * reinstalling an identical build must not report a staleness that is not there.
 */
const LOADED_HASH = bundleHash()

/** The bundle's current hash on disk, or a marker when unreadable. */
function bundleHash(): string {
  try {
    return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12)
  } catch {
    return 'unknown'
  }
}

/** The web server route table is the only required service. */
export const inject = ['webServer']

/** Path of the terminal WebSocket, relative to the GUI's origin. */
export const TERMINAL_WS_PATH = '/terminal-tab/ws'

/** Path of the read-only client-graph diagnostic. */
export const DIAGNOSTICS_PATH = '/terminal-tab/diagnostics'

/**
 * Mount the terminal route and register the settings namespace.
 * @param ctx - the host plugin context.
 * @param config - the plugin row's configuration, when present.
 */
export function apply(ctx: Context, config?: TerminalTabConfig): void {
  const resolved = resolveConfig(config)
  const nodePty = loadNodePty()
  const configuredShell = resolved.shell === '' ? SHELL_AUTO : resolved.shell
  let settings: SettingsScope<TerminalSettings> | undefined

  // The settings capability is optional: without it the plugin still serves the
  // terminal from its composition row, it merely exposes no settings page.
  ctx.inject(['settings'], (settingsCtx) => {
    settings = settingsCtx.settings.register(SETTINGS_NS, TerminalSettingsSchema, {
      // The cordis row is the composition layer, so the settings page shows it
      // as the inherited value and a user override layers on top of it.
      base: { shell: configuredShell, command: resolved.command },
    })
  })

  // Resolved per spawn, so a shell picked in the settings page applies to the
  // next terminal opened, while running terminals keep the process they have.
  const program = (): ReturnType<typeof resolveProgram> => {
    const current = settings?.get()
    return resolveProgram({
      command: current?.command ?? resolved.command,
      commandArgs: resolved.commandArgs,
      shell: current?.shell ?? configuredShell,
      shellArgs: resolved.shellArgs,
    })
  }
  const manager = nodePty === null
    ? null
    : new PtyManager({
      program,
      maxPerSession: resolved.maxPerSession,
      transcriptLimit: resolved.transcriptLimit,
      nodePty,
    })
  const wss = new WebSocketServer({ noServer: true })
  const trustedHosts = (): readonly string[] =>
    (ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: TERMINAL_WS_PATH,
    handler: (request, socket, head) => {
      if (!isTrustedRequest(request, trustedHosts())) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        attachTerminal({
          socket: ws,
          request,
          manager,
          defaultCwd: resolved.cwd,
          reconnectGraceMs: resolved.reconnectGraceMs,
        })
      })
    },
  }), 'dsh-terminal-tab: terminal WebSocket')

  ctx.effect(() => () => {
    wss.close()
    manager?.disposeAll()
  }, 'dsh-terminal-tab: terminal teardown')

  // A self-check the running process answers about itself: which build is
  // loaded, and is this package's row in the client module graph the page boots
  // from? It needs no service, and is registered unconditionally, because the
  // first question a deployment that shows no UI raises is whether this code is
  // loaded at all — copying a new lib/ over an installed one does not make a
  // running server re-import it.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DIAGNOSTICS_PATH,
    handler: (request, response) => {
      if (!isTrustedRequest(request, trustedHosts())) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        return
      }
      const modules = ctx.get('clientModules')
      const graph = modules?.graph()
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify({
        loadedHash: LOADED_HASH,
        currentHash: bundleHash(),
        stale: LOADED_HASH !== bundleHash(),
        clientModules: modules !== undefined,
        clientPath: modules?.clientPath(PACKAGE) ?? null,
        row: graph?.entries.find(entry => entry.id === PACKAGE) ?? null,
        batch: graph?.batches.find(candidate => candidate.entries.includes(PACKAGE)) ?? null,
        entryCount: graph?.entries.length ?? null,
        graphRev: graph?.rev ?? null,
      }, null, 2))
    },
  }), 'dsh-terminal-tab: diagnostics')
}
