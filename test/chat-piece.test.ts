// What a chat reads of its logs at one time is bounded, and the rest still arrives. A restart reports every agent at
// once and a long-lived coordinator's log is tens of megabytes: reading a whole one inside that loop held the server
// that answers the app for minutes. One pass reads one piece, a few chats are read in the background at a time, and
// those places are given up in turn so one big log cannot keep them all.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'shep-piece-home-'))
process.env.SHEPHERDR_HOME ??= home
const { Chats } = await import('../server/live/chats.ts')

const dirs = [home]
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const filler = `{"type":"summary","summary":"${'x'.repeat(60)}"}\n`
const lastLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: new Date(Date.now() - 60_000).toISOString(), sessionId: 's', uuid: text }) + '\n'

/** a log of `bytes` of filler, then a last line of its own */
function log(bytes: number, text = 'the last word'): string {
  const dir = mkdtempSync(join(tmpdir(), 'shep-piece-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, filler.repeat(Math.ceil(bytes / filler.length)) + lastLine(text))
  return file
}

const chatOf = (logs: Map<string, string>) =>
  new Chats({ record: (k: string) => (logs.has(k) ? { logs: [logs.get(k)!], kind: 'claude', started: 0 } : undefined) } as never, (k) => k, () => 'You')

const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) await Bun.sleep(25)
  return done()
}

test(
  'one pass does not carry a large log, and its end is read in the background',
  async () => {
    const chats = chatOf(new Map([['SHE-1/Agent', log(4 << 20)]]))
    const read: string[] = []
    chats.onRead = (k) => {
      read.push(k)
    }

    chats.pull('SHE-1/Agent')
    // a 4 MiB log is not carried by one pass: it is still behind, and nothing has reached its end
    const after = chats.backgroundReads()
    expect([...after.reading, ...after.queued]).toContain('SHE-1/Agent')
    expect(read).toEqual([])

    expect(await until(() => read.includes('SHE-1/Agent'), 20_000)).toBe(true)
    const done = chats.backgroundReads()
    expect(done.reading).not.toContain('SHE-1/Agent')
    expect(done.queued).not.toContain('SHE-1/Agent')
  },
  40_000,
)

test(
  'the background reader takes a few chats and gives those places up in turn',
  async () => {
    const keys = ['SHE-1/Agent', 'SHE-2/Agent', 'SHE-3/Agent']
    const logs = new Map(keys.map((k, i) => [k, log(8 << 20, `chat ${i}`)] as [string, string]))
    const chats = chatOf(logs)
    const read = new Set<string>()
    chats.onRead = (k) => {
      read.add(k)
    }

    for (const k of keys) chats.pull(k)
    // two places, and the rest waiting rather than all reading at once
    const first = chats.backgroundReads()
    expect(first.reading.length).toBeLessThanOrEqual(2)
    expect(first.reading.length + first.queued.length).toBe(3)

    // every chat gets a turn at reading, not just the first two
    const everRead = new Set(first.reading)
    expect(
      await until(() => {
        for (const k of chats.backgroundReads().reading) everRead.add(k)
        return everRead.size === keys.length
      }, 20_000),
    ).toBe(true)

    expect(await until(() => read.size === keys.length, 40_000)).toBe(true)
  },
  60_000,
)
