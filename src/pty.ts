/**
 * PTY ownership for the terminal tab.
 *
 * One terminal process per (session, tab) pair, kept alive across browser
 * reloads so a refresh does not kill the user's editor. node-pty is loaded
 * lazily: a machine where the native module is missing loses the terminal and
 * still boots the rest of the plugin tree.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import type { IPty } from 'node-pty'
import { SHELL_AUTO } from './shared.ts'

/** The slice of the node-pty module this plugin uses. */
export interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: NodePtySpawnOptions): IPty
}

/** node-pty spawn options this plugin sets. */
export interface NodePtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string | undefined>
}

/** The process a terminal starts: a configured command, or a shell. */
export interface TerminalProgram {
  readonly file: string
  readonly args: readonly string[]
}

/** Environment variable naming a shell to prefer over the platform default. */
const SHELL_ENV = 'DSH_TERMINAL_TAB_SHELL'

/** Windows fallback when no PowerShell 7 installation is found. */
const WINDOWS_FALLBACK_SHELL = 'powershell.exe'

/** POSIX fallback when `$SHELL` is unset. */
const POSIX_FALLBACK_SHELL = '/bin/bash'

/**
 * Load node-pty, or report that the native module is unavailable.
 * @returns the module, or null when it cannot be required.
 */
export function loadNodePty(): NodePtyModule | null {
  try {
    const requireFromPlugin = createRequire(import.meta.url)
    return requireFromPlugin('node-pty') as NodePtyModule
  } catch {
    return null
  }
}

/**
 * Resolve the program a terminal starts.
 * @param config - the plugin's resolved configuration.
 * @param platform - the target platform, injectable for tests.
 * @param env - the environment to read, injectable for tests.
 * @returns the executable and its arguments.
 */
export function resolveProgram(
  config: { command: string; commandArgs: readonly string[]; shell: string; shellArgs: readonly string[] },
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalProgram {
  if (config.command !== '') {
    return { file: resolveExecutable(config.command, platform, env), args: [...config.commandArgs] }
  }
  const shell = resolveShell(config.shell, platform, env)
  const args = config.shellArgs.length > 0 ? [...config.shellArgs] : defaultShellArgs(platform)
  return { file: shell, args }
}

/** Shell arguments for a platform: a login shell on POSIX, none on Windows. */
function defaultShellArgs(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [] : ['-l']
}

/**
 * Choose the shell a terminal starts.
 *
 * The value comes from the user's settings, so it is either one of the
 * {@link SHELL_CHOICES} keywords or a path/program name the user typed.
 * @param choice - the settings value; `auto` or empty follows the platform.
 * @param platform - the target platform, injectable for tests.
 * @param env - the environment to read, injectable for tests.
 * @returns an executable path or name.
 */
export function resolveShell(
  choice: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = choice.trim()
  const keyword = value.toLowerCase()
  if (keyword === '' || keyword === SHELL_AUTO) {
    if (platform === 'win32') {
      const configured = env[SHELL_ENV]?.trim()
      if (configured !== undefined && configured !== '') return configured
      return findPowerShell(env) ?? WINDOWS_FALLBACK_SHELL
    }
    const configured = env.SHELL?.trim()
    return configured !== undefined && configured !== '' ? configured : POSIX_FALLBACK_SHELL
  }
  if (keyword === 'pwsh' || keyword === 'pwsh.exe') {
    // PowerShell 7 is the intent, but a machine without it still gets a shell.
    return findPowerShell(env) ?? (platform === 'win32' ? 'pwsh.exe' : 'pwsh')
  }
  if (keyword === 'powershell' || keyword === 'powershell.exe') return WINDOWS_FALLBACK_SHELL
  if (keyword === 'cmd' || keyword === 'cmd.exe') return platform === 'win32' ? 'cmd.exe' : 'cmd'
  if (keyword === 'bash') return platform === 'win32' ? 'bash.exe' : 'bash'
  return value
}

/** The first PowerShell 7 installation found, or undefined. */
function findPowerShell(env: NodeJS.ProcessEnv): string | undefined {
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Microsoft'),
    env.LOCALAPPDATA,
  ].filter((root): root is string => root !== undefined && root !== '')
  for (const root of roots) {
    for (const relative of ['PowerShell\\7\\pwsh.exe', 'PowerShell\\7-preview\\pwsh.exe', 'Programs\\PowerShell\\7\\pwsh.exe']) {
      const candidate = join(root, relative)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve a program name to something the platform can execute.
 *
 * Windows process creation does not reliably apply `PATH` and `PATHEXT` to a
 * bare name — which is exactly how a user writes `command: nvim` — so a bare
 * name is expanded here.
 * @param command - the configured command.
 * @param platform - the target platform, injectable for tests.
 * @param env - the environment to read, injectable for tests.
 * @returns the name unchanged off Windows, or a resolved path.
 */
export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32') return command
  if (command.includes('\\') || command.includes('/')) return command
  const extensions = extname(command) === ''
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(part => part !== '')
    : []
  const directories = (env.PATH ?? '').split(';').filter(part => part !== '')
  for (const directory of directories) {
    const candidates = extensions.length === 0
      ? [command]
      : [command, ...extensions.map(extension => command + extension.toLowerCase())]
    for (const candidate of candidates) {
      const full = join(directory, candidate)
      if (existsSync(full)) return full
    }
  }
  return command
}

/** A live terminal process and the output buffered for a reconnecting browser. */
export interface PtyHandle {
  readonly key: string
  readonly pty: IPty
  readonly cwd: string
  readonly sessionId: string
  readonly tabId: string
  /** Recent output, replayed to a browser that attaches after it was produced. */
  transcript: string
  /** Set once the process has exited. */
  exited: boolean
}

/** Construction options for a {@link PtyManager}. */
export interface PtyManagerOptions {
  /**
   * Resolves the program to start. Read per spawn rather than held, so a shell
   * changed in the settings page applies to the next terminal opened; a
   * terminal already running keeps the process it started.
   */
  readonly program: () => TerminalProgram
  readonly maxPerSession: number
  readonly transcriptLimit: number
  readonly nodePty: NodePtyModule
}

/** Terminal lifetime and output buffering. */
export class PtyManager {
  private readonly sessions = new Map<string, PtyHandle>()
  private readonly pendingCloses = new Map<string, NodeJS.Timeout>()
  private readonly parked = new Set<string>()
  private readonly options: PtyManagerOptions

  /**
   * @param options - the program to run, the terminal limits, and the loaded node-pty module.
   */
  constructor(options: PtyManagerOptions) {
    this.options = options
  }

  /**
   * Open the terminal for one (session, tab) pair, reusing a live one.
   * @param sessionId - the conversation session owning the terminal.
   * @param tabId - the terminal tab within that session.
   * @param cwd - the requested working directory.
   * @param cols - initial columns.
   * @param rows - initial rows.
   * @returns the live handle.
   * @throws {Error} when the session already holds {@link PtyManagerOptions.maxPerSession} terminals.
   */
  open(sessionId: string, tabId: string, cwd: string, cols: number, rows: number): PtyHandle {
    const key = `${sessionId}:${tabId}`
    const existing = this.sessions.get(key)
    if (existing !== undefined && !existing.exited && existing.cwd === cwd) {
      this.cancelClose(key)
      return existing
    }
    if (existing !== undefined) this.close(key)
    this.sweepExited(sessionId)
    if (this.countFor(sessionId) >= this.options.maxPerSession) {
      throw new Error(`终端数量已达上限（每个会话 ${String(this.options.maxPerSession)} 个）`)
    }
    const program = this.options.program()
    const pty = this.options.nodePty.spawn(program.file, [...program.args], {
      name: 'xterm-256color',
      cols: clampDimension(cols, 80),
      rows: clampDimension(rows, 24),
      cwd,
      env: { ...process.env },
    })
    const handle: PtyHandle = { key, pty, cwd, sessionId, tabId, transcript: '', exited: false }
    this.sessions.set(key, handle)
    pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > this.options.transcriptLimit) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - this.options.transcriptLimit)
      }
    })
    pty.onExit(() => {
      handle.exited = true
    })
    return handle
  }

  /**
   * Resize a terminal, ignoring a platform refusal.
   * @param handle - the terminal to resize.
   * @param cols - requested columns.
   * @param rows - requested rows.
   * @returns true when the resize was applied.
   */
  resize(handle: PtyHandle, cols: number, rows: number): boolean {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || handle.exited) return false
    try {
      handle.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24))
      return true
    } catch {
      // A terminal that rejects a resize (a dying ConPTY, for instance) keeps
      // running at its previous size; the browser re-sends on the next layout.
      return false
    }
  }

  /**
   * Close a terminal after a delay, unless a reconnecting browser cancels it.
   * @param key - the terminal key.
   * @param delayMs - grace period in milliseconds.
   */
  scheduleClose(key: string, delayMs: number): void {
    this.cancelClose(key)
    this.pendingCloses.set(key, setTimeout(() => {
      this.close(key)
    }, delayMs))
  }

  /**
   * Keep a terminal alive across a page reload.
   * @param key - the terminal key.
   */
  park(key: string): void {
    this.cancelClose(key)
    this.parked.add(key)
  }

  /**
   * Whether a terminal was parked by its view.
   * @param key - the terminal key.
   * @returns true when the terminal is parked.
   */
  isParked(key: string): boolean {
    return this.parked.has(key)
  }

  /**
   * Cancel a pending close and clear the parked mark.
   * @param key - the terminal key.
   */
  cancelClose(key: string): void {
    const timer = this.pendingCloses.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pendingCloses.delete(key)
    }
    this.parked.delete(key)
  }

  /**
   * Kill one terminal immediately.
   * @param key - the terminal key.
   */
  close(key: string): void {
    this.cancelClose(key)
    const handle = this.sessions.get(key)
    if (handle === undefined) return
    this.sessions.delete(key)
    try {
      handle.pty.kill()
    } catch {
      // A process that already exited has nothing left to kill.
    }
  }

  /** Kill every terminal. */
  disposeAll(): void {
    for (const timer of this.pendingCloses.values()) clearTimeout(timer)
    this.pendingCloses.clear()
    for (const key of [...this.sessions.keys()]) this.close(key)
  }

  /** Drop exited handles of one session so they do not count against its limit. */
  private sweepExited(sessionId: string): void {
    for (const [key, handle] of [...this.sessions]) {
      if (handle.sessionId === sessionId && handle.exited) this.close(key)
    }
  }

  /** Live terminals owned by one session. */
  private countFor(sessionId: string): number {
    let count = 0
    for (const handle of this.sessions.values()) {
      if (handle.sessionId === sessionId && !handle.exited) count += 1
    }
    return count
  }
}

/**
 * Clamp a reported dimension into the range a terminal accepts.
 * @param value - the reported value.
 * @param fallback - the value used when the report is unusable.
 * @returns an integer between 2 and 1024.
 */
export function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1024, Math.max(2, Math.floor(value)))
}
