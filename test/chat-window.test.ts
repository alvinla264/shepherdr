// The arithmetic a long chat's window is drawn from (plugins/chat/window.ts), with no browser: which rows to draw for a
// viewport at a scroll position, and how far down the list each starts.
import { describe, expect, test } from 'bun:test'
import { ABOVE, BELOW, FIRST, GAP, Sizes, atTop, offset, windowAt } from '../plugins/chat/window.ts'

/** `n` rows of the same height, all measured */
const even = (n: number, height = 100) => {
  const keys = Array.from({ length: n }, (_, i) => `m${i}`)
  const sizes = new Sizes()
  for (const k of keys) sizes.set(k, height)
  return { keys, sizes }
}

describe('a row of a long chat', () => {
  test("is measured with the gap after it, and one not drawn yet takes the average of those that were, once", () => {
    const sizes = new Sizes()
    expect(sizes.height('first')).toBe(FIRST)
    expect(sizes.set('a', 100)).toBe(true)
    expect(sizes.set('a', 100.2)).toBe(false)
    expect(sizes.set('b', 200)).toBe(true)
    expect(sizes.height('a')).toBe(100)
    // counted while 78, 100 and 200 were known: it keeps that, or walking the list twice would not add up
    expect(sizes.height('first')).toBe(FIRST)
    expect(sizes.height('other')).toBe((FIRST + 100 + 200) / 3)
    expect(sizes.set('a', 300)).toBe(true)
    expect(sizes.height('other')).toBe((FIRST + 100 + 200) / 3)
  })

  test('the gap is the chat list’s own (gap-3.5), so a spacer and the rows add up', () => {
    expect(GAP).toBe(14)
  })
})

describe('where a chat is scrolled to', () => {
  test('the row at the top is the first one whose bottom is still below it', () => {
    const { keys, sizes } = even(100)
    expect(atTop(sizes, keys, 0)).toEqual({ index: 0, offset: 0 })
    expect(atTop(sizes, keys, 1)).toEqual({ index: 0, offset: 0 })
    expect(atTop(sizes, keys, 100)).toEqual({ index: 1, offset: 100 })
    expect(atTop(sizes, keys, 1234)).toEqual({ index: 12, offset: 1200 })
    // past the end it stops on the last row
    expect(atTop(sizes, keys, 99_999)).toEqual({ index: 99, offset: 9900 })
  })

  test('from a hint, it walks only the rows the scroll crossed', () => {
    const { keys, sizes } = even(1000)
    const hint = atTop(sizes, keys, 50_000)
    expect(hint.index).toBe(500)
    expect(atTop(sizes, keys, 50_120, hint)).toEqual({ index: 501, offset: 50_100 })
    expect(atTop(sizes, keys, 49_880, hint)).toEqual({ index: 498, offset: 49_800 })
    // and it says the same as walking the list whole
    expect(atTop(sizes, keys, 49_880, hint)).toEqual(atTop(sizes, keys, 49_880))
  })

  test('rows of different heights add up to their places in the list', () => {
    const keys = ['a', 'b', 'c', 'd']
    const sizes = new Sizes()
    sizes.set('a', 30)
    sizes.set('b', 300)
    sizes.set('c', 45)
    sizes.set('d', 60)
    expect(offset(sizes, keys, 0)).toBe(0)
    expect(offset(sizes, keys, 2)).toBe(330)
    expect(offset(sizes, keys, 4)).toBe(435)
    expect(atTop(sizes, keys, 330).index).toBe(2)
    expect(atTop(sizes, keys, 329).index).toBe(1)
    // from a hint, and from the top, the same: a row starts where the one before it ends, not where its own ends
    expect(atTop(sizes, keys, 330, { index: 1, offset: 30 })).toEqual({ index: 2, offset: 330 })
    expect(atTop(sizes, keys, 45, { index: 0, offset: 0 })).toEqual({ index: 1, offset: 30 })
    expect(atTop(sizes, keys, 30, { index: 0, offset: 0 })).toEqual({ index: 1, offset: 30 })
  })
})

describe('the rows a window draws', () => {
  test('what shows, and ABOVE above it and BELOW below', () => {
    const { keys, sizes } = even(1000)
    // a 600 px viewport at 40 000: rows 400 to 406 show
    const w = windowAt(sizes, keys, 40_000, 600)
    expect(w.index).toBe(400)
    expect(w.start).toBe(400 - ABOVE)
    expect(w.end).toBe(406 + BELOW)
  })

  test('at either end it stops at the list', () => {
    const { keys, sizes } = even(1000)
    expect(windowAt(sizes, keys, 0, 600)).toMatchObject({ start: 0, end: 6 + BELOW })
    const end = windowAt(sizes, keys, 99_999, 600)
    expect(end.index).toBe(999)
    expect(end.start).toBe(999 - ABOVE)
    expect(end.end).toBe(1000)
  })

  test('a list shorter than the viewport draws all of it, and an empty one draws nothing', () => {
    const small = even(3)
    expect(windowAt(small.sizes, small.keys, 0, 600)).toMatchObject({ start: 0, end: 3 })
    expect(windowAt(new Sizes(), [], 0, 600)).toMatchObject({ start: 0, end: 0 })
  })

  test('scrolled anywhere, the row it says is at the top is the one that covers the scroll position', () => {
    const { keys, sizes } = even(500, 67)
    for (const top of [0, 1, 66, 67, 5_000, 20_123, 33_000]) {
      const { index } = atTop(sizes, keys, top)
      expect(offset(sizes, keys, index)).toBeLessThanOrEqual(top)
      if (index + 1 < keys.length) expect(offset(sizes, keys, index + 1)).toBeGreaterThan(top)
    }
  })
})
