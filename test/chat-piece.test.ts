// What a chat reads of its logs at one time is bounded. A restart reports every agent at once, and a long-lived
// coordinator's log is tens of megabytes: reading a whole one inside that loop held the server that answers the app
// for minutes (its own requests queued behind the parses). One pass reads one piece; the rest follows in the
// background, a turn at a time, until the log is read to its end.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME ??= mkdtempSync(join(tmpdir(), 'shep-piece-'))
const { Chats } = await import('../server/live/chats.ts')

const KEY = 'SHE-9/Agent'
const line = `{"type":"summary","summary":"${'x'.repeat(60)}"}\n`
const chat = (file: string) =>
  new Chats({ record: () => ({ logs: [file], kind: 'claude', started: 0 }) } as never, (k) => k, () => 'You')

test('one pull reads one piece of a large log, and the rest is read to the end in the background', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shep-piece-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, line.repeat(Math.ceil((4 << 20) / line.length)))

  const chats = chat(file)
  let ends = 0
  chats.onRead = () => {
    ends++
  }

  const started = performance.now()
  chats.pull(KEY)
  const took = performance.now() - started
  // the piece is small enough to parse at once: it never carries the whole log
  expect(took).toBeLessThan(2000)
  expect(ends).toBe(0)

  const until = Date.now() + 20_000
  while (!ends && Date.now() < until) await Bun.sleep(50)
  expect(ends).toBe(1)
})

test('the turn that answers the app comes back while a log is still being read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shep-piece-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, line.repeat(Math.ceil((4 << 20) / line.length)))

  const chats = chat(file)
  let ends = 0
  chats.onRead = () => {
    ends++
  }
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  try {
    chats.pull(KEY)
    // timers run between pieces: the background reading does not hold the loop
    const until = Date.now() + 20_000
    while (!ends && Date.now() < until) await Bun.sleep(50)
    expect(ends).toBe(1)
    expect(ticks).toBeGreaterThan(2)
  } finally {
    clearInterval(timer)
  }
})
