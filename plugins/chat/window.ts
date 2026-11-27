// The arithmetic behind drawing only the messages near what a chat shows (window.tsx), with no DOM in it: how tall a
// row is, where the row at the top of the viewport starts, and which rows to draw for a viewport at a scroll position.
// A row's height with the gap that follows it is what is kept, so the rows of a list add up to their places in it.

/** the gap between rows in the chat's list: Tailwind's gap-3.5 */
export const GAP = 14
/** a first guess at a row's height, its gap included, before one has been drawn: a short bubble on a phone */
export const FIRST = 78
/** how many rows are drawn above and below what shows */
export const ABOVE = 40
export const BELOW = 40

/** how tall each row of a list is, as far as it has been drawn: one never drawn takes the average of those that were */
export class Sizes {
  private known = new Map<string, number>()
  private sum = 0
  /** the row's height with its gap: what it last measured, or the average of what the drawn rows measured, counted once
      and then kept as it was (a row walked over twice must weigh the same both times, or the places the list works out
      for its rows stop adding up) */
  height(key: string): number {
    const was = this.known.get(key)
    if (was !== undefined) return was
    const first = this.known.size ? this.sum / this.known.size : FIRST
    this.known.set(key, first)
    this.sum += first
    return first
  }
  /** what a drawn row measured; true when that is not what it was */
  set(key: string, height: number): boolean {
    const was = this.known.get(key)
    if (was !== undefined && Math.abs(was - height) < 0.5) return false
    this.known.set(key, height)
    this.sum += height - (was ?? 0)
    return true
  }
}

/** where a row sits in a list: its index, and how far (px) from the list's top it starts */
export type Place = { index: number; offset: number }

/** how far down the list the row at `i` starts */
export function offset(sizes: Sizes, keys: readonly string[], i: number): number {
  let y = 0
  for (let j = 0; j < i && j < keys.length; j++) y += sizes.height(keys[j])
  return y
}

/** the row at the top of the viewport: the first one whose bottom is still below it. Walked from `hint` (the last
    answer), so scrolling only crosses the rows it goes past, not the whole list */
export function atTop(sizes: Sizes, keys: readonly string[], top: number, hint?: Place): Place {
  const n = keys.length
  if (!n) return { index: 0, offset: 0 }
  let index = Math.min(Math.max(hint?.index ?? 0, 0), n - 1)
  let y = hint?.offset ?? 0
  // up: the row above starts where this one does, less its own height
  while (index > 0 && y > top) {
    index--
    y -= sizes.height(keys[index])
  }
  // down: the next row starts where this one ends, its height and gap later
  while (index < n - 1) {
    const height = sizes.height(keys[index])
    if (y + height > top) break
    y += height
    index++
  }
  return { index, offset: y }
}

/** the rows to draw: what shows in a viewport of `view` px at `top`, and ABOVE above it and BELOW below */
export function windowAt(sizes: Sizes, keys: readonly string[], top: number, view: number, hint?: Place): { start: number; end: number } & Place {
  const n = keys.length
  if (!n) return { index: 0, offset: 0, start: 0, end: 0 }
  const { index, offset: y } = atTop(sizes, keys, top, hint)
  let end = index
  let bottom = y
  while (end < n && bottom < top + view) {
    bottom += sizes.height(keys[end])
    end++
  }
  return { index, offset: y, start: Math.max(0, index - ABOVE), end: Math.min(n, end + BELOW) }
}

type Ask = { chat: string; id: string }
const asks = new Set<(a: Ask) => void>()

/** ask a chat to draw a message, however far from what shows it is: a search hit, a quote, an alert's link (reply.ts) */
export function reveal(chat: string, id: string) {
  for (const f of asks) f({ chat, id })
}

/** hear those asks; a chat's window draws around the message, and the jump finds it drawn */
export function onReveal(f: (a: Ask) => void) {
  asks.add(f)
  return () => void asks.delete(f)
}
