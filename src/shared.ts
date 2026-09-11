/**
 * Values both halves of the plugin share.
 *
 * This module must stay free of Node and browser APIs: the host bundle, the
 * browser bundle, and the settings schema all import it, and anything it pulled
 * in would be dragged into the browser bundle.
 */

/** The settings namespace this plugin registers. Lowercase and hyphenated. */
export const SETTINGS_NS = 'dsh-terminal-tab'

/** The `shell` setting meaning "let the platform decide". */
export const SHELL_AUTO = 'auto'

/**
 * Shell keywords the settings page offers. Each resolves to a concrete
 * executable on the host; any other value is taken as a path or program name.
 */
export const SHELL_CHOICES = ['auto', 'pwsh', 'powershell', 'cmd', 'bash'] as const

/** One shell keyword the settings page offers. */
export type ShellChoice = (typeof SHELL_CHOICES)[number]

/** xterm's palette keys this plugin exposes, named exactly as xterm names them. */
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
}

/** Palette entries describing the terminal's own chrome, in presentation order. */
export const THEME_CHROME_KEYS = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
] as const satisfies readonly (keyof TerminalTheme)[]

/** The eight ANSI base colours, in presentation order. */
export const THEME_ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const satisfies readonly (keyof TerminalTheme)[]

/** Every palette key, chrome first: the order the schema and the card both use. */
export const THEME_KEYS: readonly (keyof TerminalTheme)[] = [
  ...THEME_CHROME_KEYS,
  ...THEME_ANSI_KEYS,
]

/** Every value the settings page edits. */
export interface TerminalSettings {
  /** Shell to start: a keyword from {@link SHELL_CHOICES}, or a path. */
  shell: string
  /** Program to start instead of a shell; empty starts the shell. */
  command: string
  /** CSS font-family list the terminal renders with. */
  fontFamily: string
  /** Terminal font size in pixels. */
  fontSize: number
  /** Terminal palette. */
  theme: TerminalTheme
}

/** Font size used before the user changes it. */
export const DEFAULT_FONT_SIZE = 13

/** Font size bounds the settings page and the host schema both enforce. */
export const FONT_SIZE_MIN = 6

/** Upper font size bound. */
export const FONT_SIZE_MAX = 32

/**
 * Font stack used before the user changes it.
 *
 * Monospace faces that ship with Windows, ending in the generic family so a
 * machine with none of them still gets a monospaced terminal. A browser falls
 * back per glyph, so CJK text renders from the system font without this list
 * having to name a CJK face.
 */
export const DEFAULT_FONT_FAMILY = "'Cascadia Mono', Consolas, 'Courier New', monospace"

/** Font names the settings page offers as one-click picks. */
export const FONT_FAMILY_SUGGESTIONS = [
  "'Cascadia Mono', Consolas, 'Courier New', monospace",
  "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "'Sarasa Mono SC', 'Cascadia Mono', Consolas, monospace",
  'Consolas, monospace',
  'monospace',
] as const

/**
 * Palette used before the user changes it: white background, dark text.
 *
 * The ANSI colours are the darker end of each hue rather than the bright one, so
 * every colour stays legible against white — a light terminal that keeps the
 * dark-theme ANSI values is where "white background" usually looks broken.
 */
export const DEFAULT_THEME: TerminalTheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  selectionBackground: '#b6d7ff',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
}

/**
 * The settings shape with every default applied: what the plugin uses before a
 * value is accepted, and what a cleared field reverts to.
 */
export const DEFAULT_SETTINGS: TerminalSettings = {
  shell: SHELL_AUTO,
  command: '',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  theme: DEFAULT_THEME,
}

/**
 * Normalize a settings payload read off the wire.
 *
 * The wire admits unconstrained JSON, so every field is checked here rather
 * than trusted: a form that stored a string where a number belongs, or a
 * document edited by hand, must not reach xterm as an unusable option.
 * @param value - the resolved namespace value from the settings wire.
 * @returns the settings, with any unusable field replaced by its default.
 */
export function readSettings(value: unknown): TerminalSettings {
  const record = isRecord(value) ? value : {}
  const themeRecord = isRecord(record.theme) ? record.theme : {}
  const theme = {} as TerminalTheme
  for (const key of THEME_KEYS) {
    const candidate = themeRecord[key]
    theme[key] = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : DEFAULT_THEME[key]
  }
  return {
    shell: typeof record.shell === 'string' ? record.shell : SHELL_AUTO,
    command: typeof record.command === 'string' ? record.command : '',
    fontFamily: readFontFamily(record.fontFamily),
    fontSize: readFontSize(record.fontSize),
    theme,
  }
}

/** A usable font stack, or the default. */
function readFontFamily(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_FONT_FAMILY
  const trimmed = value.trim()
  return trimmed === '' ? DEFAULT_FONT_FAMILY : trimmed
}

/**
 * Read a typed colour as the `#rrggbb` a palette entry stores.
 *
 * Typing is how most people move a colour between tools, so the three forms a
 * hex code is written in all land on one value: `#abc`, `abc`, and `#aabbcc`
 * (case-insensitively). Anything else is not a colour and returns undefined, so
 * a half-typed value never reaches the terminal.
 * @param text - what the user typed or pasted.
 * @returns the normalized colour, or undefined when the text is not one.
 */
export function parseHexColor(text: string): string | undefined {
  const digits = text.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(digits)) {
    const [red, green, blue] = digits.toLowerCase()
    return `#${red}${red}${green}${green}${blue}${blue}`
  }
  return /^[0-9a-f]{6}$/i.test(digits) ? `#${digits.toLowerCase()}` : undefined
}

/** A font size inside the supported range, or the default. */
function readFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)))
}

/** Whether a wire value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
