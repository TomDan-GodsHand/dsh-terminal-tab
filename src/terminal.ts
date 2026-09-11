/**
 * One browser connection to one terminal process.
 *
 * The socket owns the terminal only while it is open: a browser that
 * disconnects parks its terminal for the reconnect grace period, so a page
 * reload or a session switch does not kill a running editor.
 */
import { statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type { PtyManager } from './pty.ts'
import { parseControl } from './wire.ts'

/** Reason sent when the native PTY module is unavailable on this deployment. */
export const PTY_DEPS_MISSING = 'pty-deps-missing'

/** Output dropped rather than queued once this many bytes are unsent. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** Attachment options for {@link attachTerminal}. */
export interface AttachOptions {
  readonly socket: WebSocket
  readonly request: IncomingMessage
  /** The terminal registry, or null when node-pty could not be loaded. */
  readonly manager: PtyManager | null
  /** Working directory used when the client does not name one. */
  readonly defaultCwd: string
  /** How long the terminal survives a disconnect, in milliseconds. */
  readonly reconnectGraceMs: number
}

/**
 * Wire one upgraded socket to its terminal process.
 * @param options - the socket, its request, and the terminal registry.
 */
export function attachTerminal(options: AttachOptions): void {
  const { socket, manager } = options
  const url = new URL(options.request.url ?? '/', 'http://dsh.internal')
  const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
  if (sessionId === '') {
    socket.close(1008, 'sessionId is required')
    return
  }
  if (manager === null) {
    socket.close(1011, PTY_DEPS_MISSING)
    return
  }
  const tabId = url.searchParams.get('tab')?.trim() || 'main'
  const cwd = absoluteExistingDirectory(url.searchParams.get('cwd')) ?? options.defaultCwd
  const cols = dimension(url.searchParams.get('cols'), 80)
  const rows = dimension(url.searchParams.get('rows'), 24)

  let handle
  try {
    handle = manager.open(sessionId, tabId, cwd, cols, rows)
  } catch (error) {
    socket.close(1011, error instanceof Error ? error.message : String(error))
    return
  }

  const send = (data: string): void => {
    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) socket.send(data)
  }
  if (handle.transcript !== '') send(handle.transcript)
  const dataSub = handle.pty.onData(send)
  const exitSub = handle.pty.onExit(({ exitCode }) => {
    send(`\r\n[进程已退出，代码 ${String(exitCode)}]\r\n`)
  })

  socket.on('message', (data: unknown) => {
    const text = frameText(data)
    const control = parseControl(text)
    if (control === null) {
      if (!handle.exited) handle.pty.write(text)
      return
    }
    if (control.type === 'resize') {
      manager.resize(handle, control.cols, control.rows)
      return
    }
    if (control.type === 'close') {
      manager.scheduleClose(handle.key, 0)
      return
    }
    manager.park(handle.key)
  })

  socket.on('close', () => {
    dataSub.dispose()
    exitSub.dispose()
    if (!manager.isParked(handle.key)) manager.scheduleClose(handle.key, options.reconnectGraceMs)
  })
}

/** Decode one inbound frame as UTF-8 text. */
function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  return String(data)
}

/** A requested dimension, or the fallback when the query is unusable. */
function dimension(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.floor(value) : fallback
}

/** The query's working directory, when it names an existing absolute directory. */
function absoluteExistingDirectory(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = raw.trim()
  if (!/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('/')) return undefined
  try {
    return statSync(value).isDirectory() ? value : undefined
  } catch {
    return undefined
  }
}
