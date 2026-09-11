/**
 * Plugin configuration, resolved from the cordis patch row.
 *
 * Every key is optional. Resolution is explicit here rather than through a
 * schema so the plugin carries no configuration dependency: the plugin row in
 * `cordis.patch.yml` supplies whatever the deployment wants to change, and
 * everything else falls back to the value documented in README.md.
 */

/** Configuration accepted on the plugin's cordis row. */
export interface TerminalTabConfig {
  /** Program the terminal starts. Empty (the default) starts {@link TerminalTabConfig.shell}. */
  command?: string
  /** Arguments for {@link TerminalTabConfig.command}. */
  commandArgs?: string[]
  /** Shell used when no command is configured. Empty selects the platform default. */
  shell?: string
  /** Shell arguments. Empty means the platform default: `-l` on POSIX, none on Windows. */
  shellArgs?: string[]
  /** Working directory. Empty follows the server process's own directory. */
  cwd?: string
  /** Concurrent terminals allowed per session. */
  maxPerSession?: number
  /** How long a terminal survives a browser disconnect, in milliseconds. */
  reconnectGraceMs?: number
  /** Bytes of output replayed to a reconnecting browser. */
  transcriptLimit?: number
}

/** Configuration with every default applied. */
export interface ResolvedTerminalConfig {
  readonly command: string
  readonly commandArgs: readonly string[]
  readonly shell: string
  readonly shellArgs: readonly string[]
  readonly cwd: string
  readonly maxPerSession: number
  readonly reconnectGraceMs: number
  readonly transcriptLimit: number
}

/** The name of a shell whose arguments default to a login shell. */
const POSIX_DEFAULT_SHELL = '/bin/bash'

/**
 * Apply defaults to the plugin row's configuration.
 * @param config - raw configuration from the cordis row, when present.
 * @returns the configuration with every default applied.
 */
export function resolveConfig(config?: TerminalTabConfig): ResolvedTerminalConfig {
  return {
    command: config?.command?.trim() ?? '',
    commandArgs: config?.commandArgs ?? [],
    shell: config?.shell?.trim() ?? '',
    shellArgs: config?.shellArgs ?? [],
    cwd: config?.cwd?.trim() ?? process.cwd(),
    maxPerSession: positive(config?.maxPerSession, 3),
    reconnectGraceMs: positive(config?.reconnectGraceMs, 30_000, 0),
    transcriptLimit: positive(config?.transcriptLimit, 256 * 1024),
  }
}

/** A configured count, or the fallback when absent or unusable. */
function positive(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined || !Number.isFinite(value) || value < minimum) return fallback
  return Math.floor(value)
}

/** The shell a POSIX terminal falls back to when nothing else is configured. */
export { POSIX_DEFAULT_SHELL }
