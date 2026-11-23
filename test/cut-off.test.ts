// Two things a busy server must get right: a cut-off is decided only from a chat's log once that log has caught up (a
// log still being read, growing, unreadable, gone, or ending in half a line leaves it undetermined - never a decision
// from a part or from a stale error), and the screens read each second are a few chats nobody watches, in turn, plus
// every chat on screen and every blocked one.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'shep-cut-home-'))
process.env.SHEPHERDR_HOME ??= home
const { Chats } = await import('../server/live/chats.ts')
const { screensInTurn } = await import('../server/live/source.ts')

const dirs = [home]
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const line = (o: object) => JSON.stringify(o) + '\n'
const user = (text: string, at: number) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: new Date(at).toISOString(), sessionId: 's', uuid: text })
const error = (text: string, at: number) =>
  line({
    type: 'assistant',
    message: { id: text, role: 'assistant', content: [{ type: 'text', text }] },
    isApiErrorMessage: true,
    error: 'overloaded_error',
    timestamp: new Date(at).toISOString(),
    sessionId: 's',
    uuid: text,
  })

function logFile(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'shep-cut-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, rows.join(''))
  return file
}

const chatOf = (file: string) =>
  new Chats({ record: (k: string) => ({ logs: [file], kind: 'claude', started: 0 }) } as never, (k) => k, () => 'You')

test('a cut-off is decided from the end of a chat it has caught up with', () => {
  const now = Date.now() - 1000
  const chats = chatOf(logFile([user('do the thing', now - 2000), error('overloaded', now)]))
  expect(chats.cutOffIfCaughtUp('T-1/Agent')).toMatchObject({ decided: true, cut: { text: 'overloaded' } })
  expect(chats.upToDate('T-1/Agent')).toBe(true)
})

test('an error with a later turn above it is not the current cut-off', () => {
  const now = Date.now() - 1000
  const chats = chatOf(logFile([error('overloaded', now - 3000), user('carry on', now - 1000)]))
  const decision = chats.cutOffIfCaughtUp('T-2/Agent')
  expect(decision.decided).toBe(true)
  expect(decision.cut).toBeUndefined()
})

test('a chat with no log of its own is undetermined, not decided', () => {
  const chats = new Chats({ record: () => ({ logs: [], kind: 'claude', started: 0 }) } as never, (k) => k, () => 'You')
  expect(chats.cutOffIfCaughtUp('T-4/Agent')).toEqual({ decided: false })
})

test('a log that is gone is not the end of anything', () => {
  const file = logFile([error('overloaded', Date.now() - 1000)])
  const chats = chatOf(file)
  expect(chats.cutOffIfCaughtUp('T-5/Agent')).toMatchObject({ decided: true, cut: { text: 'overloaded' } })
  rmSync(file, { force: true })
  expect(chats.cutOffIfCaughtUp('T-5/Agent')).toEqual({ decided: false })
})

test('a replaced log is read again before anything is decided from it', () => {
  const file = logFile([error('overloaded', Date.now() - 1000)])
  const chats = chatOf(file)
  expect(chats.cutOffIfCaughtUp('T-6/Agent')).toMatchObject({ decided: true, cut: { text: 'overloaded' } })
  // the same path, now an empty log: what was read of the old file is not this chat's history any more, so it is read
  // again from the start and only then decided - and what it says now has no error in it
  writeFileSync(file, '')
  const after = chats.cutOffIfCaughtUp('T-6/Agent')
  expect(after.decided).toBe(true)
  expect(after.cut).toBeUndefined()
})

test('a log that cannot be read leaves the cut-off undetermined', () => {
  if (process.getuid?.() === 0) return // root reads through the mode bits
  const file = logFile([error('overloaded', Date.now() - 1000)])
  const chats = chatOf(file)
  expect(chats.cutOffIfCaughtUp('T-7/Agent')).toMatchObject({ decided: true, cut: { text: 'overloaded' } })
  chmodSync(file, 0o000)
  expect(chats.cutOffIfCaughtUp('T-7/Agent')).toEqual({ decided: false })
  chmodSync(file, 0o600)
})

test(
  'a log still being read is undetermined, and decided once it is at its end',
  async () => {
    const rows = [user('a long turn', Date.now() - 60_000), error('overloaded', Date.now() - 1000)]
    const file = logFile([`{"type":"summary","summary":"${'x'.repeat(60)}"}\n`.repeat(Math.ceil((2 << 20) / 65)), ...rows])
    const chats = chatOf(file)

    // still behind: nothing may be decided from the part read so far
    expect(chats.cutOffIfCaughtUp('T-3/Agent')).toEqual({ decided: false })

    const end = Date.now() + 20_000
    while (!chats.upToDate('T-3/Agent') && Date.now() < end) await Bun.sleep(50)
    expect(chats.cutOffIfCaughtUp('T-3/Agent')).toMatchObject({ decided: true, cut: { text: 'overloaded' } })
  },
  40_000,
)

test('the screens read each second are a few chats nobody watches, in order, and wrap', () => {
  const keys = ['C/Agent', 'A/Agent', 'B/Agent', 'D/Agent', 'E/Agent']
  const first = screensInTurn(keys, [], '', 2)
  expect(first.turns).toEqual(['A/Agent', 'B/Agent'])
  const next = screensInTurn(keys, [], first.after, 2)
  expect(next.turns).toEqual(['C/Agent', 'D/Agent'])
  const wrapped = screensInTurn(keys, [], 'D/Agent', 2)
  expect(wrapped.turns).toEqual(['E/Agent', 'A/Agent'])
})

test('what is skipped - a chat on screen, a blocked one - is never in the turn, and a short list reads only what it has', () => {
  const keys = ['A/Agent', 'B/Agent', 'C/Agent']
  expect(screensInTurn(keys, ['B/Agent'], '', 4).turns).toEqual(['A/Agent', 'C/Agent'])
  expect(screensInTurn(keys, keys.slice(), '', 4).turns).toEqual([])
  expect(screensInTurn(['A/Agent'], [], '', 4).turns).toEqual(['A/Agent'])
})

test('four a sweep covers a hundred agents in twenty-five sweeps, each once', () => {
  const many = Array.from({ length: 100 }, (_, i) => `K${String(i).padStart(3, '0')}/Agent`)
  const seen = new Set<string>()
  let after = ''
  for (let i = 0; i < 25; i++) {
    const step = screensInTurn(many, [], after, 4)
    expect(step.turns.length).toBe(4)
    for (const k of step.turns) seen.add(k)
    after = step.after
  }
  expect(seen.size).toBe(100)
})
