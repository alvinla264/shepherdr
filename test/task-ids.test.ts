// A space's task IDs: the prefix and next number set in its Settings, reserved on the machine that owns it.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TASK_NUMBER, TaskIds, prefixProblem, taskIdsSection } from '../server/live/task-ids.ts'
import type { Space } from '../server/live/places.ts'

const at = (name: string) => `p:machine:${name}`
const repo = (name: string, key: string): Space => ({ name, path: `/repos/${name}`, key, github: null, base: 'main', added: 1 })
const home = () => mkdtempSync(join(tmpdir(), 'shep-ids-'))
type Legacy = { next: Record<string, number>; tasks: { id: string; n: number; project: string }[] }
const nothing = (): Legacy => ({ next: {}, tasks: [] })
const ids = (spaces: Space[], legacy = nothing(), dir = home(), idOf = at) => new TaskIds(spaces, legacy, idOf, dir)

describe('the numbers a space hands out', () => {
  test('a prefix and a next number decide the new tasks; the next number only moves forward, and a new prefix keeps counting', () => {
    const game = repo('game', 'GAME')
    const t = ids([game], { next: { GAME: 7 }, tasks: [{ id: 'GAME-7', n: 7, project: at('game') }] })
    try {
      expect(t.set(at('game'), 'taskIds.next', '100').last).toBe(99)
      expect(t.allocate(at('game'))).toEqual({ id: 'GAME-100', n: 100, prefix: 'GAME' })
      expect(t.allocate(at('game')).id).toBe('GAME-101')
      expect(() => t.set(at('game'), 'taskIds.next', '101')).toThrow('102 or higher')
      expect(() => t.set(at('game'), 'taskIds.next', '50')).toThrow('102 or higher')
      // a prefix change affects new tasks only: the number carries on where it was
      t.set(at('game'), 'taskIds.prefix', 'PLAY')
      expect(t.allocate(at('game')).id).toBe('PLAY-102')
      expect(game.key).toBe('GAME')
    } finally { t.close() }
  })
  test('a number handed out is kept, even though its task never arrived: deletions, gaps and a restart do not reuse it', () => {
    const dir = home()
    const stale: Legacy = { next: { WEB: 250 }, tasks: [] }
    const first = ids([repo('web', 'WEB')], stale, dir)
    first.set(at('web'), 'taskIds.next', '300')
    expect(first.allocate(at('web')).id).toBe('WEB-300')
    // another engine on the same home, with the old tasks.json in hand, carries on rather than back
    const second = ids([repo('web', 'WEB')], stale, dir)
    try {
      expect(second.allocate(at('web')).id).toBe('WEB-301')
      first.set(at('web'), 'taskIds.prefix', 'SITE')
      expect(second.allocate(at('web')).id).toBe('SITE-302')
      expect(() => second.set(at('web'), 'taskIds.next', '250')).toThrow()
    } finally { first.close(); second.close() }
    // a restart finds the prefix the ledger holds, not the one spaces.json last mirrored
    const spaces = [repo('web', 'WEB')]
    const again = ids(spaces, stale, dir)
    try {
      expect(spaces[0].key).toBe('SITE')
      expect(again.allocate(at('web')).id).toBe('SITE-303')
    } finally { again.close() }
  })
  test('a prefix belongs to one space, now or in its past, and one no space owns is kept too', () => {
    const t = ids([repo('a', 'A'), repo('b', 'B')], { next: { GONE: 3 }, tasks: [] })
    try {
      for (const prefix of ['A', 'GONE']) expect(() => t.set(at('b'), 'taskIds.prefix', prefix)).toThrow('reserved')
      t.set(at('a'), 'taskIds.prefix', 'NEW')
      expect(() => t.set(at('b'), 'taskIds.prefix', 'A')).toThrow('reserved')
      expect(t.keys()).toEqual(expect.arrayContaining(['A', 'GONE', 'NEW']))
      expect(() => t.ensure(at('c'), 'A')).toThrow('reserved')
      // a space that appears after the ledger opened gets its own prefix and starts at 1
      t.ensure(at('c'), 'C')
      expect(t.allocate(at('c')).id).toBe('C-1')
    } finally { t.close() }
  })
  test('another machine keeps its own ledger, so the same prefix there counts on its own', () => {
    const a = ids([repo('a', 'GAME')], nothing(), home(), at)
    const b = ids([repo('b', 'GAME')], nothing(), home(), (name) => `p:remote:${name}`)
    try {
      expect(a.allocate(at('a')).id).toBe('GAME-1')
      expect(b.allocate('p:remote:b').id).toBe('GAME-1')
    } finally { a.close(); b.close() }
  })
})

describe('what Settings accepts', () => {
  test('a prefix is 1–16 capitals or digits, starting with a letter', () => {
    for (const bad of ['', 'game', 'GAME-2', '2GAME', 'G A', 'A'.repeat(17)]) expect(prefixProblem(bad)).toBeDefined()
    for (const good of ['A', 'GAME', 'API2', 'A'.repeat(16)]) expect(prefixProblem(good)).toBeUndefined()
  })
  test('a next number is a whole number from 1 up, and the last one can be handed out before it runs out', () => {
    const t = ids([repo('a', 'A')])
    try {
      for (const bad of ['', '0', '-1', '1.5', '1e3', '007', String(Number.MAX_SAFE_INTEGER)]) expect(() => t.set(at('a'), 'taskIds.next', bad)).toThrow()
      expect(() => t.set(at('a'), 'something.else', '1')).toThrow('No such task ID setting')
      t.set(at('a'), 'taskIds.next', String(MAX_TASK_NUMBER))
      expect(t.allocate(at('a')).n).toBe(MAX_TASK_NUMBER)
      expect(() => t.allocate(at('a'))).toThrow('exhausted')
    } finally { t.close() }
  })
  test('the page is its space’s own: two typed fields, no inherited value to reset, and its own words', () => {
    const page = taskIdsSection('p:machine:a', 'machine', 'GAME', 100)
    expect(page).toMatchObject({ name: 'Task IDs', level: 'p:machine:a', machine: 'machine' })
    expect(page.global).toBeUndefined()
    expect(page.rows.map((r) => [r.label, r.key, r.value])).toEqual([['Prefix', 'taskIds.prefix', 'GAME'], ['Next number', 'taskIds.next', '100']])
    expect(page.rows.every((r) => r.text && !r.inherits)).toBe(true)
    expect(page.about).toContain('Existing IDs stay the same')
    expect(page.rows[1].hint).toContain('Next task: GAME-100')
  })
})
