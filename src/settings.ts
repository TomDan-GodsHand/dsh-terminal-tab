/**
 * The settings namespace schema.
 *
 * Defaults here are what an untouched deployment uses, so the settings page
 * shows the effective value rather than an empty field. The shape and defaults
 * live in `shared.ts` because the browser half normalizes the same fields.
 */
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SETTINGS_NS,
  SHELL_AUTO,
  type TerminalSettings,
} from './shared.ts'

export { SETTINGS_NS, type TerminalSettings }

/** The namespace schema, registered by the host half. */
export const TerminalSettingsSchema = z.object({
  shell: z.string().default(SHELL_AUTO),
  command: z.string().default(''),
  fontFamily: z.string().default(DEFAULT_FONT_FAMILY),
  fontSize: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).step(1).default(DEFAULT_FONT_SIZE),
  theme: z.object({
    background: z.string().default(DEFAULT_THEME.background),
    foreground: z.string().default(DEFAULT_THEME.foreground),
    cursor: z.string().default(DEFAULT_THEME.cursor),
    selectionBackground: z.string().default(DEFAULT_THEME.selectionBackground),
    black: z.string().default(DEFAULT_THEME.black),
    red: z.string().default(DEFAULT_THEME.red),
    green: z.string().default(DEFAULT_THEME.green),
    yellow: z.string().default(DEFAULT_THEME.yellow),
    blue: z.string().default(DEFAULT_THEME.blue),
    magenta: z.string().default(DEFAULT_THEME.magenta),
    cyan: z.string().default(DEFAULT_THEME.cyan),
    white: z.string().default(DEFAULT_THEME.white),
  }),
})
