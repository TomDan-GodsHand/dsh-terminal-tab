/**
 * dsh-terminal-tab — browser half.
 *
 * Contributes two entries, both reading one bound settings scope:
 *
 * - `conversation.view`, the tab ring that already holds Chat and Trajectory;
 * - `settings.plugin.item`, the 终端 card under 设置 / 插件 / 插件设置, keyed by
 *   the settings namespace the host half registers.
 *
 * The plugin settings tab renders the intersection of the namespaces the host
 * serves and the cards registered under this slot, so the card and the host
 * namespace must agree on the key.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merge that declares ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'conversation.view' SlotMap row and its props.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the 'settings.plugin.item' SlotMap row, declared by the tab that
// dispatches it.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the client settings scope contract.
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import xtermStylesheet from '@xterm/xterm/css/xterm.css'
import {
  DEFAULT_SETTINGS,
  readSettings,
  SETTINGS_NS,
  THEME_KEYS,
  type TerminalSettings,
} from '../shared.ts'
import type { TerminalSettingsCardInjected, TerminalSettingsInjected } from './contract.ts'
import cardStylesheet from './settings-card.css'
import { SettingsCard } from './SettingsCard.tsx'
import { installStylesheet } from './stylesheet.ts'
import pluginStylesheet from './terminal-view.css'
import { TerminalView } from './TerminalView.tsx'

/** The package owning this plugin's stylesheets and module-table row. */
const PACKAGE = 'dsh-terminal-tab'

/** Scalar fields of the namespace section, in the order a write lists them. */
const SCALAR_FIELDS = ['shell', 'command', 'fontFamily', 'fontSize'] as const

/**
 * One path-addressed settings write.
 *
 * Structural rather than imported: it is the wire's `SettingsPathOpView`, whose
 * declaring package is not part of this plugin's compile face. Path addressing
 * is what makes a write safe from a redacted view — the caller names the field it
 * means instead of restating a section it never fully saw.
 */
type SettingsOp =
  | { op: 'set', path: string[], value: string | number }
  | { op: 'unset', path: string[] }

// Stylesheets are injected once, when this bundle materializes, so a tab or card
// is never rendered unstyled while its own effect has yet to run.
installStylesheet(PACKAGE, 'xterm.css', xtermStylesheet)
installStylesheet(PACKAGE, 'terminal-view.css', pluginStylesheet)
installStylesheet(PACKAGE, 'settings-card.css', cardStylesheet)

/** The slot service, and the settings scope both entries read. */
export const inject = ['slots', 'settingsScope']

/**
 * Build the write for one staged value.
 * @param values - the staged value.
 * @param reference - what the write is measured against: the schema defaults
 *   after a full restore, otherwise the value the Host currently resolves.
 * @param restoreAll - clear every override before the edits that follow.
 * @returns ordered path edits; empty when nothing changed.
 */
function settingsOps(values: TerminalSettings, reference: TerminalSettings, restoreAll: boolean): SettingsOp[] {
  const ops: SettingsOp[] = restoreAll ? [{ op: 'unset', path: [] }] : []
  for (const field of SCALAR_FIELDS) {
    if (values[field] !== reference[field]) ops.push({ op: 'set', path: [field], value: values[field] })
  }
  for (const key of THEME_KEYS) {
    if (values.theme[key] !== reference.theme[key]) {
      ops.push({ op: 'set', path: ['theme', key], value: values.theme[key] })
    }
  }
  return ops
}

/**
 * Register the 终端 tab and its settings card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const settings: SettingsScope<TerminalSettings> = ctx.settingsScope.bind<TerminalSettings>({
    namespace: SETTINGS_NS,
    // The wire admits unconstrained JSON; narrow it here rather than trusting a
    // stored document that may have been edited by hand.
    decode: (section) => readSettings(section),
  })
  const readFace = (): TerminalSettingsInjected => ({ hooks: { settings } })

  // inject() waits for the slot's declaration, so each entry also re-registers
  // when its owning surface is rebuilt.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'terminal',
    order: 20,
    label: () => '终端',
    inject: readFace,
  }, TerminalView))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // Must equal the namespace the host half registers; that equality is the
    // only thing pairing this card with those values.
    key: SETTINGS_NS,
    inject: (): TerminalSettingsCardInjected => ({
      ...readFace(),
      apply: async (values, restoreAll) => {
        // After a full restore the reference is the schema defaults — the root
        // unset has already returned every field to them. Otherwise the
        // reference is what the Host resolves now, so only real changes ride.
        const reference = restoreAll
          ? DEFAULT_SETTINGS
          : (settings.getSnapshot().value ?? DEFAULT_SETTINGS)
        const ops = settingsOps(values, reference, restoreAll)
        if (ops.length === 0) return
        await settings.mutate(ops)
      },
    }),
  }, SettingsCard))
}
