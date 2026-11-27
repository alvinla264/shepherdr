// What the store keeps when a snapshot or a chat arrives: the pure comparison behind an idle screen that draws nothing
// (shared/quiet.ts). Unchanged input is the same object; a part a view reads changing makes a new object, a part it
// does not read changing leaves that part's identity as it was.
import { describe, expect, test } from 'bun:test'
import { carry, same } from '../shared/quiet.ts'

const snap = (over: Record<string, unknown> = {}) => ({
  places: [{ id: 'p:1', name: 'home' }],
  tasks: [{ id: 'T-1', status: 'work' }],
  machines: [{ id: 'm:1', name: 'here' }],
  last: { 'p:1': 10 },
  ...over,
})

describe('same', () => {
  test('is the same all the way down, and not by identity alone', () => {
    expect(same(snap(), snap())).toBe(true)
    expect(same({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false)
    // a key there and not there, an array and an object, a value of another type
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(same([1], { 0: 1 })).toBe(false)
    expect(same(1, '1')).toBe(false)
    expect(same(null, undefined)).toBe(false)
    expect(same(null, null)).toBe(true)
  })
})

describe('carry', () => {
  test('unchanged input is the very same object: nothing to notify, nothing to draw', () => {
    const before = snap()
    expect(carry(before, snap())).toBe(before)
  })

  test('a part a view reads changing makes a new snapshot, that part alone replaced', () => {
    const before = snap()
    const after = carry(before, snap({ tasks: [{ id: 'T-1', status: 'need' }] }))
    expect(after).not.toBe(before)
    expect(after.tasks).not.toBe(before.tasks)
    expect(after.tasks).toEqual([{ id: 'T-1', status: 'need' }])
  })

  test('a part it does not read changing leaves every part it does read with its identity', () => {
    const before = snap()
    const after = carry(before, snap({ last: { 'p:1': 11 } }))
    expect(after).not.toBe(before)
    expect(after.last).not.toBe(before.last)
    // what a list reads is still the objects it had, so it need not draw again
    expect(after.tasks).toBe(before.tasks)
    expect(after.places).toBe(before.places)
    expect(after.machines).toBe(before.machines)
  })

  test('a part that is equal but was built again is taken from before, not kept new', () => {
    const before = snap()
    const after = carry(before, snap({ last: { 'p:1': 11 } }))
    expect(after.tasks).toBe(before.tasks)
    expect(same(after, snap({ last: { 'p:1': 11 } }))).toBe(true)
  })

  test('a row that did not change keeps its own object inside a list that was rebuilt', () => {
    const before = snap({ tasks: [{ id: 'T-1', status: 'work' }, { id: 'T-2', status: 'work' }] })
    const after = carry(before, snap({ tasks: [{ id: 'T-1', status: 'need' }, { id: 'T-2', status: 'work' }] }))
    expect(after.tasks).not.toBe(before.tasks)
    expect(after.tasks[0]).not.toBe(before.tasks[0])
    // another task's row is still the object it drew
    expect(after.tasks[1]).toBe(before.tasks[1])
    // a message added keeps the ones already there, so their rows are the ones on screen
    const grown = carry({ key: 'p:1', messages: [{ id: 'a' }] }, { key: 'p:1', messages: [{ id: 'a' }, { id: 'b' }] })
    expect(grown.messages).not.toHaveLength(1)
    expect(grown.messages[0]).toEqual({ id: 'a' })
  })

  test('a key gone from the snapshot is gone: carry does not put it back', () => {
    const before = snap()
    const next = snap({ last: { 'p:1': 11 } })
    delete (next as { places?: unknown }).places
    const after = carry(before, next)
    expect('places' in after).toBe(false)
  })

  test('a chat whose messages did not change keeps its messages, one that got a message gets a new list', () => {
    const before = { key: 'p:1', messages: [{ id: 'a' }], working: true }
    const typing = carry(before, { key: 'p:1', messages: [{ id: 'a' }], working: false })
    expect(typing).not.toBe(before)
    expect(typing.messages).toBe(before.messages)
    const said = carry(before, { key: 'p:1', messages: [{ id: 'a' }, { id: 'b' }], working: true })
    expect(said.messages).not.toBe(before.messages)
  })
})
