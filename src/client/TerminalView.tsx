/**
 * The 终端 conversation view: an xterm.js screen bound to one terminal process.
 *
 * The view owns the socket, not the process. On unmount it parks the terminal,
 * so switching tabs or reloading the page keeps the session's editor alive; only
 * a tab left closed past the host's reconnect grace period ends the process, and
 * a dropped socket reconnects on its own.
 *
 * The terminal owns the whole view: no toolbar, no padding. Everything a toolbar
 * used to offer is either the shell's own job (type `nvim`) or a setting
 * (`启动命令`), and a connection message floats over the terminal instead of
 * taking a row from it.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: merges the Session standard kit (including `sessionId`) into the
// props a session-scoped slot component receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS, type TerminalSettings, type TerminalTheme } from '../shared.ts'
import type { TerminalSettingsInjected } from './contract.ts'

/** The host route carrying terminal bytes. */
const WS_PATH = '/terminal-tab/ws'

/** Reconnect attempts before the view reports a failure. */
const FAILURE_LIMIT = 3

/** Delay between reconnect attempts, in milliseconds. */
const RETRY_DELAY_MS = 2000

/** Terminal tab id within one session; one terminal per session. */
const TAB_ID = 'main'

/** Scrollback lines retained by the browser. */
const SCROLLBACK = 4000

/** The view's props: the slot's own share plus this plugin's inject face. */
type TerminalViewProps = ConvViewProps & InjectFace<TerminalSettingsInjected>

/**
 * Render the terminal tab.
 * @param props - the conversation view's runtime props and the settings read face.
 * @returns the terminal view.
 */
export function TerminalView(props: TerminalViewProps): ReactElement {
  const sessionId = props.sessionId
  // The renderer binds an inject `hooks` entry as a *selector* hook: its
  // argument goes straight to useSyncExternalStoreWithSelector, which calls it.
  // Omitting the selector makes that call `undefined` and crashes the entry at
  // render, so every read passes one — the convention the built-in cards use.
  const settings = props.useSettings((snapshot: SettingsScopeSnapshot<TerminalSettings>) => snapshot)
  const values = settings.value ?? DEFAULT_SETTINGS
  const hostRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resizeRef = useRef<(() => void) | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: SCROLLBACK,
      // xterm paints the palette's background itself; transparency would let the
      // page background show through instead of the configured colour.
      fontFamily: values.fontFamily,
      fontSize: values.fontSize,
      theme: toXtermTheme(values.theme),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    terminalRef.current = term
    fitRef.current = fit

    let attempt = 0
    let retry = 0
    let frame = 0
    let opened = false
    let closed = false

    const sendResize = (): void => {
      const socket = socketRef.current
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    resizeRef.current = sendResize

    const connect = (): void => {
      const url = new URL(WS_PATH, location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({
        sessionId,
        tab: TAB_ID,
        cols: String(term.cols),
        rows: String(term.rows),
      }).toString()
      const socket = new WebSocket(url)
      socketRef.current = socket
      socket.onopen = () => {
        attempt = 0
        setNotice(null)
        setFatal(null)
        fit.fit()
        sendResize()
      }
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') term.write(event.data)
      }
      socket.onclose = (event: CloseEvent) => {
        if (closed) return
        if (event.code === 1011) {
          setFatal(event.reason === '' ? '终端进程启动失败。' : event.reason)
          return
        }
        attempt += 1
        if (attempt > FAILURE_LIMIT) {
          setFatal('无法连接终端，请刷新页面重试。')
          return
        }
        setNotice(`连接已断开，正在重连（${String(attempt)}/${String(FAILURE_LIMIT)}）…`)
        retry = window.setTimeout(connect, RETRY_DELAY_MS)
      }
      socket.onerror = () => {
        socket.close()
      }
    }

    // xterm renders nothing into a zero-sized container, and this view mounts
    // into a shell that may not have laid out the tab body yet.
    const waitForSize = (): void => {
      if (closed || !host.isConnected) return
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        opened = true
        term.open(host)
        fit.fit()
        connect()
        sendResize()
        return
      }
      frame = window.requestAnimationFrame(waitForSize)
    }
    frame = window.requestAnimationFrame(waitForSize)

    const inputSub = term.onData((data: string) => {
      const socket = socketRef.current
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
    })
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        if (closed || !opened) return
        fit.fit()
        sendResize()
      })
    })
    observer.observe(host)

    return () => {
      closed = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(retry)
      observer.disconnect()
      inputSub.dispose()
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
      resizeRef.current = null
      const socket = socketRef.current
      socketRef.current = null
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        // Park, then disconnect: the host keeps the process for its reconnect
        // grace period, so returning to this tab resumes the same terminal.
        socket.send(JSON.stringify({ type: 'park' }))
        socket.close()
      }
    }
  }, [sessionId])

  // Settings edited while this view is mounted reach the live terminal here: the
  // creation effect above only ever sees the values it mounted with.
  useEffect(() => {
    const term = terminalRef.current
    const fit = fitRef.current
    if (term === null || fit === null) return
    term.options.fontFamily = values.fontFamily
    term.options.fontSize = values.fontSize
    term.options.theme = toXtermTheme(values.theme)
    fit.fit()
    resizeRef.current?.()
  }, [values.fontFamily, values.fontSize, values.theme])

  return (
    <div className="dshTerminalTabRoot">
      <div
        ref={hostRef}
        className="dshTerminalTabScreen"
        // The block's colour is the configured terminal background, so the view
        // shows the palette rather than the page for the moment before xterm
        // paints its first frame.
        style={{ background: values.theme.background }}
      />
      {/* No toolbar: a message would have nowhere to live, so it floats over the
          terminal instead of taking height away from it. */}
      {fatal !== null ? <span className="dshTerminalTabNotice">{fatal}</span> : null}
      {fatal === null && notice !== null ? <span className="dshTerminalTabNotice">{notice}</span> : null}
    </div>
  )
}

/**
 * Map the settings palette onto xterm's theme. The keys are the same words on
 * both sides, so this is a copy — spelled out rather than spread so a palette
 * key added to xterm cannot leak into the theme unnoticed.
 * @param theme - the configured palette.
 * @returns xterm's theme object.
 */
function toXtermTheme(theme: TerminalTheme): ITheme {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    selectionBackground: theme.selectionBackground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
  }
}
