/**
 * The inject faces this plugin's two browser entries consume.
 *
 * Both entries read the same bound settings scope, so a value changed in the
 * settings page reaches the terminal view without either knowing about the
 * other. The scope is a bare observable and therefore rides the reserved
 * `hooks` compartment; the renderer binds that compartment to a `useSettings`
 * selector hook, and the write path stays a plain inject member.
 *
 * The hooks entry is declared as the framework's own observable currency rather
 * than as the richer scope object, so the bound hook's snapshot type is derived
 * instead of collapsing to `any`.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TerminalSettings } from '../shared.ts'

/** Shared read face: the terminal view and the settings card both read it. */
export interface TerminalSettingsInjected {
  hooks: {
    settings: HostObservable<SettingsScopeSnapshot<TerminalSettings>>
  }
}

/**
 * Write face of the settings card.
 *
 * The card stages edits and hands the whole staged value here on save, so the
 * diff against what the Host currently holds — and the path-addressed write
 * shape that carries a redacted view safely — stay in the plugin's apply world
 * rather than in a component.
 */
export interface TerminalSettingsCardInjected extends TerminalSettingsInjected {
  /**
   * Persist staged edits.
   * @param values - the complete staged value.
   * @param restoreAll - clear every user override first, so each field
   *   re-inherits the composition layer, then apply whatever still differs.
   * @returns settlement after the write and any recovery read.
   */
  apply: (values: TerminalSettings, restoreAll: boolean) => Promise<void>
}
