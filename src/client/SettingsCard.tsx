/**
 * The settings card inside 设置 / 插件 / 插件设置.
 *
 * It renders the same row the page's own cards render — a bordered, rounded
 * disclosure whose header is the row itself — and edits the same way: controls
 * stage a draft, the header marks it 未保存, and only 保存 writes, through the
 * inject face's `apply`. The page already ships a card named 终端 for the `shell`
 * capability (the bash tool's timeout and output limits), so this one is named
 * Terminal: it configures the 终端 tab beside 对话 and 轨迹 — which shell that tab
 * starts, and how it looks.
 *
 * Staging is also what keeps the write safe: the value the Host holds may have
 * come back redacted, so the write is a path-addressed diff rather than a
 * wholesale replacement (see `settingsOps` in `index.tsx`).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the client settings scope snapshot the bound hook yields.
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'settings.plugin.item' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  DEFAULT_SETTINGS,
  FONT_FAMILY_SUGGESTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  parseHexColor,
  SHELL_CHOICES,
  THEME_ANSI_KEYS,
  THEME_CHROME_KEYS,
  type TerminalSettings,
  type TerminalTheme,
} from '../shared.ts'
import type { TerminalSettingsCardInjected } from './contract.ts'

/**
 * Card name. The page's own 终端 card configures the shell capability the bash
 * tool uses, so this card is named for the tab it configures instead.
 */
const CARD_TITLE = 'Terminal'

/** One line naming what these settings govern. */
const CARD_DESCRIPTION = '控制「终端」标签页所用的 shell、字号与配色。'

/** Palette labels, in {@link THEME_KEYS} order. */
const THEME_LABELS: Readonly<Record<keyof TerminalTheme, string>> = {
  background: '背景',
  foreground: '文字',
  cursor: '光标',
  selectionBackground: '选中背景',
  black: '黑',
  red: '红',
  green: '绿',
  yellow: '黄',
  blue: '蓝',
  magenta: '品红',
  cyan: '青',
  white: '白',
}

/** Datalist id for the shell field; one card exists per page. */
const SHELL_LIST_ID = 'dsh-terminal-tab-shells'

/** Datalist id for the font-family field. */
const FONT_LIST_ID = 'dsh-terminal-tab-fonts'

/**
 * Render the terminal settings card.
 * @param props - the keyed slot's props plus this plugin's inject face.
 * @returns the card row, collapsed until the user opens it.
 */
export function SettingsCard(
  props: PropsRuntime<'settings.plugin.item'> & InjectFace<TerminalSettingsCardInjected>,
): ReactElement {
  // A selector is mandatory: the renderer hands this hook's argument straight to
  // useSyncExternalStoreWithSelector, which calls it.
  const settings = props.useSettings((snapshot: SettingsScopeSnapshot<TerminalSettings>) => snapshot)
  const accepted = settings.value
  const [draft, setDraft] = useState<TerminalSettings | null>(null)
  const [restoreStaged, setRestoreStaged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  // In-progress hex text per palette entry: a half-typed code is not a colour, so
  // it lives here until it parses rather than in the staged value.
  const [hexText, setHexText] = useState<Record<string, string>>({})

  // Re-seed the draft whenever the Host accepts a value, so a saved or externally
  // changed value is what the form shows next.
  useEffect(() => {
    setDraft(null)
    setRestoreStaged(false)
    setFailed(false)
    setHexText({})
  }, [accepted])

  const values = draft ?? accepted ?? DEFAULT_SETTINGS
  const dirty = draft !== null
  const invalid = !inRange(values.fontSize)
  const unavailable = settings.status === 'unavailable'
  const disabled = !settings.writable || unavailable
  const blocked = !dirty || invalid || saving || disabled

  /**
   * Type one colour as hex.
   *
   * A code that parses stages the colour immediately, so the picker, the preview
   * and the terminal agree as the user types; one that does not stays in the text
   * box and is dropped on blur, which is what keeps an unusable value out of the
   * write.
   */
  const editHex = (key: keyof TerminalTheme, text: string): void => {
    setHexText(current => ({ ...current, [key]: text }))
    const parsed = parseHexColor(text)
    if (parsed !== undefined) stage({ theme: { ...values.theme, [key]: parsed } })
  }

  /** Drop unparsable text, falling back to the colour actually staged. */
  const commitHex = (key: keyof TerminalTheme): void => {
    setHexText((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  /** One palette field: swatch, name, and an editable hex code. */
  const swatch = (key: keyof TerminalTheme): ReactElement => (
    <div key={key} className="dshTerminalSwatch">
      <input
        id={`dsh-terminal-tab-color-${key}`}
        type="color"
        value={values.theme[key]}
        disabled={disabled}
        onChange={(event) => {
          stage({ theme: { ...values.theme, [key]: event.target.value } })
        }}
      />
      <label htmlFor={`dsh-terminal-tab-color-${key}`}>{THEME_LABELS[key]}</label>
      <input
        type="text"
        className="dshTerminalHex"
        value={hexText[key] ?? values.theme[key]}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${THEME_LABELS[key]} 色值`}
        onChange={(event) => {
          editHex(key, event.target.value)
        }}
        onBlur={() => {
          commitHex(key)
        }}
      />
    </div>
  )

  /** Stage a patch; nothing reaches the Host until 保存. */
  const stage = (patch: Partial<TerminalSettings>): void => {
    setDraft({ ...values, ...patch, theme: { ...values.theme, ...patch.theme } })
    setFailed(false)
  }

  /** Drop every staged edit. */
  const discard = (): void => {
    setDraft(null)
    setRestoreStaged(false)
    setFailed(false)
    setHexText({})
  }

  /** Stage a full revert to the schema defaults; 保存 then clears the overrides. */
  const restoreDefaults = (): void => {
    setDraft(DEFAULT_SETTINGS)
    setRestoreStaged(true)
    setFailed(false)
    setHexText({})
  }

  /** Write the staged value, then collapse the card the way the others do. */
  const save = (): void => {
    setSaving(true)
    setFailed(false)
    void props.apply(values, restoreStaged)
      .then(() => {
        setDraft(null)
        setRestoreStaged(false)
        setHexText({})
        setOpen(false)
      })
      .catch(() => {
        // The scope reloads Host state after a refused write, so the draft is
        // kept: the user can retry or discard without losing the edit.
        setFailed(true)
      })
      .finally(() => {
        setSaving(false)
      })
  }

  return (
    <li className={open ? 'dshTerminalCard dshTerminalCardOpen' : 'dshTerminalCard'}>
      <button
        type="button"
        className="dshTerminalCardHeader"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}: ${CARD_TITLE}`}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="dshTerminalCardHeadText">
          <span className="dshTerminalCardName">{CARD_TITLE}</span>
          <span className="dshTerminalCardDescription">{CARD_DESCRIPTION}</span>
        </span>
        {dirty ? <Tag tone="neutral" className="dshTerminalPending">未保存</Tag> : null}
        <IconChevronDownOutline14
          className={open ? 'dshTerminalCardChevron dshTerminalCardChevronOpen' : 'dshTerminalCardChevron'}
        />
      </button>

      {open ? (
        <div className="dshTerminalCardBody">
          <div className="dshTerminalRow">
            <label htmlFor="dsh-terminal-tab-shell">终端 Shell</label>
            <input
              id="dsh-terminal-tab-shell"
              className="dshTerminalInput"
              list={SHELL_LIST_ID}
              value={values.shell}
              disabled={disabled}
              onChange={(event) => {
                stage({ shell: event.target.value })
              }}
            />
            <datalist id={SHELL_LIST_ID}>
              {SHELL_CHOICES.map(choice => <option key={choice} value={choice} />)}
            </datalist>
          </div>
          <div className="dshTerminalHint">
            auto 跟随平台（Windows 优先 pwsh，其次 powershell），也可以直接填可执行文件路径。改动对
            <b>之后新开</b>的终端生效，已经在跑的终端保持原进程。
          </div>

          <div className="dshTerminalRow">
            <label htmlFor="dsh-terminal-tab-command">启动命令</label>
            <input
              id="dsh-terminal-tab-command"
              className="dshTerminalInput"
              placeholder="留空则启动 shell"
              value={values.command}
              disabled={disabled}
              onChange={(event) => {
                stage({ command: event.target.value })
              }}
            />
          </div>
          <div className="dshTerminalHint">填了就直接启动它（例如 nvim），不经过 shell。</div>

          <div className="dshTerminalRow">
            <label htmlFor="dsh-terminal-tab-font-family">字体</label>
            <input
              id="dsh-terminal-tab-font-family"
              className="dshTerminalInput"
              list={FONT_LIST_ID}
              value={values.fontFamily}
              disabled={disabled}
              onChange={(event) => {
                stage({ fontFamily: event.target.value })
              }}
            />
            <datalist id={FONT_LIST_ID}>
              {FONT_FAMILY_SUGGESTIONS.map(family => <option key={family} value={family} />)}
            </datalist>
          </div>
          <div className="dshTerminalHint">
            填 CSS 的 font-family 列表（逗号分隔，可加引号）。排第一的没装就依次回退；中文字形由系统字体补。
          </div>

          <div className="dshTerminalRow">
            <label htmlFor="dsh-terminal-tab-font-size">字号</label>
            <input
              id="dsh-terminal-tab-font-size"
              className="dshTerminalInput dshTerminalNumber"
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={values.fontSize}
              disabled={disabled}
              aria-invalid={invalid}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isFinite(next)) stage({ fontSize: next })
              }}
            />
            <span className="dshTerminalHint">
              {invalid
                ? `请填 ${String(FONT_SIZE_MIN)}–${String(FONT_SIZE_MAX)} 之间的整数`
                : `${String(FONT_SIZE_MIN)}–${String(FONT_SIZE_MAX)} px`}
            </span>
          </div>

          <div className="dshTerminalGroupHeading">界面颜色</div>
          <div className="dshTerminalSwatches">
            {THEME_CHROME_KEYS.map(swatch)}
          </div>

          <div className="dshTerminalGroupHeading">ANSI 颜色</div>
          <div className="dshTerminalSwatches">
            {THEME_ANSI_KEYS.map(swatch)}
          </div>
          <div className="dshTerminalHint dshTerminalHintWide">
            色值可以直接填：支持 <code>#aabbcc</code>、<code>aabbcc</code>、<code>#abc</code>（# 可省，大小写都行），
            填完按回车或点别处即生效；填了不合法的会还原成原来的颜色。
          </div>

          <div
            className="dshTerminalPreview"
            style={{ background: values.theme.background, color: values.theme.foreground }}
          >
            <span className="dshTerminalPreviewLabel">预览</span>
            {THEME_ANSI_KEYS.map(key => (
              <span key={key} style={{ color: values.theme[key] }}>{THEME_LABELS[key]}</span>
            ))}
          </div>

          <div className="dshTerminalFooter">
            <span className={failed ? 'dshTerminalFailed' : 'dshTerminalStatus'}>
              {failed ? '保存失败，未写入。' : statusText(settings.status, settings.writable)}
            </span>
            <button
              type="button"
              className="dshTerminalDiscard"
              disabled={disabled || saving}
              onClick={restoreDefaults}
            >
              恢复默认
            </button>
            <button
              type="button"
              className="dshTerminalDiscard"
              disabled={blocked}
              onClick={discard}
            >
              放弃
            </button>
            <button
              type="button"
              className="dshTerminalSave"
              disabled={blocked}
              onClick={save}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** A font size the namespace schema accepts. */
function inRange(value: number): boolean {
  return Number.isInteger(value) && value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX
}

/** The footer's state text while the form is clean. */
function statusText(
  status: 'loading' | 'ready' | 'unavailable',
  writable: boolean,
): ReactElement {
  if (status === 'loading') return <>读取设置…</>
  if (status === 'unavailable') return <>此部署未提供终端设置。</>
  if (!writable) return <>当前为只读（设置未落盘）。</>
  return <>改动点「保存」后生效</>
}
