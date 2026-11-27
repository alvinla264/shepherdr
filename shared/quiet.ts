// Whether what the server sent is still what the screen shows, and how much of it changed: the store carries every part
// that did not change, so a view that reads only some parts of a snapshot (or a chat) is not drawn again for the rest.
// Plain JSON, as it comes over the socket: no cycles, no Dates.

/** are they the same all the way down? */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!Object.hasOwn(b, k) || !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

/**
 * `next`, with each part that is the same as in `prev` taken from `prev` instead: an unchanged part keeps its identity,
 * so `carry(prev, next).tasks === prev.tasks` and a view reading `tasks` alone need not draw again. Inside a list, an
 * unchanged row keeps its own object too (a task, a message), so a row drawn again is not built from a new object. `prev`
 * itself when nothing changed at all, so the store can keep its object and tell no one.
 */
export function carry<T extends object>(prev: T, next: T): T {
  const was = prev as Record<string, unknown>
  const now = next as Record<string, unknown>
  // one walk of each part, not one of the whole and then one of each part: a long chat is compared once on every read
  let changed = Object.keys(was).length !== Object.keys(now).length
  let out: Record<string, unknown> | null = null
  for (const k of Object.keys(now)) {
    const before = was[k]
    const after = now[k]
    if (before === after) continue
    if (same(before, after)) {
      if (!out) out = { ...now }
      out[k] = before
      continue
    }
    changed = true
    const kept = keepRows(before, after)
    if (kept === after) continue
    if (!out) out = { ...now }
    out[k] = kept
  }
  return changed ? ((out ?? next) as T) : prev
}

/** the same list, with each unchanged row taken from the list on screen (a new array only where one changed) */
function keepRows(before: unknown, after: unknown): unknown {
  if (!Array.isArray(before) || !Array.isArray(after)) return after
  const out = after.slice()
  let reused = false
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] !== after[i] && same(before[i], after[i])) {
      out[i] = before[i]
      reused = true
    }
  }
  return reused ? out : after
}
