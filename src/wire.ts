/**
 * Control frames on the terminal socket.
 *
 * The socket carries raw terminal text in both directions. A frame that parses
 * as a recognized JSON control object is a control frame; anything else —
 * including JSON of an unknown shape — is terminal input, forwarded verbatim.
 * That rule is what lets a user type `{"type":"x"}` into a shell prompt.
 */

/** A recognized control frame. */
export type TerminalControl =
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'close' }
  | { readonly type: 'park' }

/**
 * Classify one inbound frame.
 * @param text - the decoded frame.
 * @returns the control frame, or null when the frame is terminal input.
 */
export function parseControl(text: string): TerminalControl | null {
  if (!text.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const frame = parsed as Record<string, unknown>
  if (frame.type === 'resize') {
    return typeof frame.cols === 'number' && typeof frame.rows === 'number'
      ? { type: 'resize', cols: frame.cols, rows: frame.rows }
      : null
  }
  if (frame.type === 'close') return { type: 'close' }
  if (frame.type === 'park') return { type: 'park' }
  return null
}
