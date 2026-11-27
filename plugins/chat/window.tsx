// A long chat draws only the messages near what it shows, with a spacer standing in for the rest (window.ts does the
// arithmetic for it): a chat whose agent ran for days opens as fast as a short one, and a live update costs the same,
// because the DOM no longer grows with the whole history. The edges stay as they were: the chat opens at its newest
// message and follows new ones, the scrollbar and a jump to the bottom stay honest, a message jumped to (a search hit,
// a quote, an alert's link) is drawn however far down the chat it is, and a row drawn again above what shows (a reply
// folding, a picture loading) keeps what shows where it showed.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useArrive } from '@client/motion.ts'
import { GAP, Sizes, atTop, offset, onReveal, windowAt, type Place } from './window.ts'

/** how many rows a chat draws at its newest message: what a phone shows, and enough above it for a scroll up */
const AT_TAIL = 120
/** how far (px) from the newest message still counts as at it, as the chat counts it (client.tsx) */
const AT_BOTTOM = 80

/** a row of the chat as the window knows it: its key, the message ids it holds (for a jump to one), and where it starts a
    day or meets the New line */
export type RowInfo = { key: string; at: number; first: string; dated: boolean; ids?: string[] }

export function Window({ chat, list, rows, draw, tail }: { chat: string; list: RefObject<HTMLDivElement | null>; rows: RowInfo[]; draw: (i: number) => ReactNode; tail?: ReactNode }) {
  const sizes = useRef(new Sizes()).current
  const top = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  /** the rows read from the scroll position: null while the chat is at its newest message, which it follows */
  const [free, setFree] = useState<{ start: number; end: number; toEnd: boolean } | null>(null)
  const scroller = useRef<HTMLElement | null>(null)
  /** what shows at the top of the viewport (or the message jumped to), and where it was, so a change above it keeps it */
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null)
  /** a message asked for (window.ts's reveal), drawn and brought into view once it is */
  const focus = useRef<string | null>(null)
  /** how far (px) down the whole list the first row drawn starts, and which row that is: kept as the rows are measured, so
      a row measured far from the top never shifts the rows above it, as an average of all of them would */
  const start = useRef({ index: 0, offset: 0 })
  /** whether that place has been worked out yet (the first draw knows only which rows it draws) */
  const placed = useRef(false)
  /** how often the scroll moved the rows drawn: those just show, they don't rise into place (motion.ts) */
  const moved = useRef(0)
  /** the rows this draw has already told the chat's search about, so the words it marks follow what is drawn */
  const told = useRef('')
  // the newest message and what is just above it, or the rows around where the chat was scrolled to
  const atTail = !free || free.end > rows.length || free.start >= rows.length
  // a window that reached the end of the chat when it was read follows it as replies come in (the New line is one of
  // them): nothing scrolls to draw them otherwise
  const drawn = atTail ? { start: Math.max(0, rows.length - AT_TAIL), end: rows.length } : { start: free.start, end: free.toEnd ? rows.length : Math.min(free.end, rows.length) }
  const keys = rows.map((r) => r.key)
  // what the listeners read: this render's rows, and where they are drawn
  const now = useRef({ rows, keys, drawn, atTail })
  now.current = { rows, keys, drawn, atTail }
  useArrive(list, `${chat}:${moved.current}`)
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    // every drawn row's height, read in one clean layout (not a read per row while React is still committing), with the
    // gap after it: the rows of the list then add up to their places in it
    const drawnRows = [...el.children].filter((n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute('data-arrive'))
    const tops = drawnRows.map((n) => n.offsetTop)
    drawnRows.forEach((n, i) => sizes.set(n.dataset.arrive!, i + 1 < drawnRows.length ? tops[i + 1] - tops[i] : n.offsetHeight + GAP))
    // where the first row drawn now starts: the rows it crossed since, and only those, at the height they were drawn
    const { keys, drawn } = now.current
    const at = start.current
    if (!placed.current) {
      placed.current = true
      at.index = drawn.start
      at.offset = offset(sizes, keys, drawn.start)
    }
    for (let j = Math.min(at.index, drawn.start); j < Math.max(at.index, drawn.start); j++) at.offset += drawn.start > at.index ? sizes.height(keys[j]) : -sizes.height(keys[j])
    at.index = drawn.start
    // rows measured while they were drawn, or a row that came back with another key, can leave the carried place a few
    // pixels off what the rows above it add up to: never below the top, and zero there (the spacer clamps and the list
    // would not line up with it)
    at.offset = drawn.start === 0 ? 0 : Math.max(0, at.offset)
    // what is not drawn stands in with a spacer as tall as the rows that are, less the gap that meets it
    height(top.current, at.offset - GAP)
    height(bottom.current, baseline(sizes, keys, drawn.end) - GAP)
    const box = scroller.current
    // a message jumped to (a search hit, a quote, an alert's link) comes into view: drawn now, on its own, before the
    // glide that jumpTo (reply.ts) makes to centre it. What shows after that is kept still on that message
    const want = focus.current
    if (want && box) {
      const node = el.querySelector<HTMLElement>(`[data-whole="${CSS.escape(want)}"], [data-msg="${CSS.escape(want)}"]`)
      if (node) {
        focus.current = null
        const r = node.getBoundingClientRect()
        const view = box.getBoundingClientRect()
        // one taller than the box shows from its top, as a card's does
        if (r.top < view.top || r.bottom > view.bottom) box.scrollTop += r.top - view.top - Math.max(0, (box.clientHeight - Math.min(r.height, box.clientHeight)) / 3)
        anchor.current = { el: node, top: node.offsetTop }
      }
    }
    // what shows stays where it showed: a reply above it folded, a picture loaded, a row drawn again was measured
    // taller or shorter, as scroll anchoring would keep it (an edit above what shows, as in any chat, moves it)
    const a = anchor.current
    if (a?.el.isConnected && box && !now.current.atTail) {
      const now = a.el.offsetTop
      if (now !== a.top) box.scrollTop += now - a.top
      a.top = now
    }
    // the rows are new (a scroll, a jump): the words the chat's search marks go with them (find.tsx)
    const which = `${drawn.start}:${drawn.end}`
    if (which !== told.current) {
      told.current = which
      dispatchEvent(new Event('shepherdr:chat-drawn'))
    }
  })
  useEffect(() => {
    const el = list.current
    if (!el) return
    let box: HTMLElement | null = null
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowY)) {
        box = p
        break
      }
    }
    if (!box) return
    scroller.current = box
    /** read the scroll position: at the bottom the chat follows its newest message; read further up, the rows around it are drawn */
    const read = () => {
      const b = scroller.current!
      const top = b.scrollTop
      const { keys, drawn, atTail } = now.current
      const left = b.scrollHeight - top - b.clientHeight
      // as the chat itself goes: only a scroll up lets go of the newest message
      if (left < AT_BOTTOM) {
        if (!atTail) setFree(null)
        return
      }
      const next = windowAt(sizes, keys, top, b.clientHeight, start.current)
      if (atTail || next.start !== drawn.start || next.end !== drawn.end) {
        anchor.current = spot(el, keys, sizes, top, start.current)
        moved.current++
        setFree({ ...next, toEnd: next.end >= keys.length })
      }
    }
    box.addEventListener('scroll', read, { passive: true })
    // the box itself changing height (a phone's keyboard) shows other rows
    const ro = new ResizeObserver(read)
    ro.observe(box)
    // the chat puts itself at its newest message, or back where it was read, as it draws: read that once it has
    queueMicrotask(read)
    return () => {
      box.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [])
  useEffect(
    () =>
      onReveal(({ chat: c, id }) => {
        if (c !== chat) return
        const { rows, keys } = now.current
        const i = rows.findIndex((r) => r.key === id || r.ids?.includes(id))
        if (i < 0) return
        focus.current = id
        moved.current++
        // where it is, as the rows are known now (the window draws it there, then the jump puts it where it shows)
        const from = down(sizes, keys, start.current, i)
        const { start: s, end } = windowAt(sizes, keys, from, scroller.current?.clientHeight ?? 600, { index: i, offset: from })
        setFree({ start: s, end, toEnd: end >= keys.length })
      }),
    [chat, sizes],
  )
  const out: ReactNode[] = [<div key="window-top" data-window-top ref={top} aria-hidden="true" className="shrink-0" />]
  for (let i = drawn.start; i < drawn.end; i++) out.push(draw(i))
  out.push(<div key="window-bottom" data-window-bottom ref={bottom} aria-hidden="true" className="shrink-0" />)
  if (tail) out.push(<Fragment key="window-tail">{tail}</Fragment>)
  return <>{out}</>
}

/** a spacer's height: none at all when nothing is missing there, so its own gap goes too */
function height(el: HTMLDivElement | null, px: number) {
  if (!el) return
  el.style.display = px > 0.5 ? '' : 'none'
  el.style.height = px > 0.5 ? `${px}px` : '0px'
}

/** how far down the list row `to` starts, walked from a row already known and its place (the rows in between are the
    only ones read: a jump into a long chat costs what it visibly crossed, not the chat's whole history) */
function down(sizes: Sizes, keys: readonly string[], from: { index: number; offset: number }, to: number) {
  let { index, offset } = from
  if (to >= index) for (; index < to; index++) offset += sizes.height(keys[index])
  else for (; index > to; index--) offset -= sizes.height(keys[index - 1])
  return offset
}

/** how far down the list its last row ends: what is below the rows drawn, at the height those rows were (or a guess) */
function baseline(sizes: Sizes, keys: readonly string[], i: number) {
  let px = 0
  for (let j = i; j < keys.length; j++) px += sizes.height(keys[j])
  return px
}

/** the row at the top of the viewport, and where it is now */
function spot(list: HTMLElement, keys: readonly string[], sizes: Sizes, top: number, hint?: Place) {
  const { index } = atTop(sizes, keys, top, hint)
  const key = keys[index]
  const el = key === undefined ? null : list.querySelector<HTMLElement>(`:scope > [data-arrive="${CSS.escape(key)}"]`)
  return el ? { el, top: el.offsetTop } : null
}
