// Task news for the coordinator that asked for the task: a private mailbox under this installation, so the news waits
// while that coordinator is offline or the server restarts, is delivered only by the installation that owns it, and is
// delivered once.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestedNewsMailbox, type RequestedNews } from '../server/live/requested-news.ts'

/** a scratch installation: its own agent records, and those of the machines it runs as workers */
function installation(own: Record<string, object> = {}, workers: Record<string, Record<string, object>> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shep-news-'))
  const records = (dir: string, agents: Record<string, object>) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agents.json'), JSON.stringify(agents))
  }
  records(root, own)
  for (const [machine, agents] of Object.entries(workers)) records(join(root, 'machines', machine), agents)
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

const note = (to: string, over: Partial<RequestedNews> = {}): Omit<RequestedNews, 'id'> => ({ to, from: 'p:desk:repo', text: 'SHE-1 is ready', task: 'SHE-1', event: 'ready', ...over })

describe('who may hear about a task', () => {
  test('a coordinator of this installation and its workers, unfinished, and no one else', () => {
    const mine = installation({ 'p:here:~': { key: 'p:here:~' }, 'p:here:old': { key: 'p:here:old', finished: true } }, { desk: { 'p:desk:repo': { key: 'p:desk:repo' }, 'SHE-9/Agent': { key: 'SHE-9/Agent' } } })
    const someoneElse = installation({ 'p:desk:repo': { key: 'p:desk:repo' } })
    try {
      const mail = new RequestedNewsMailbox(mine.root)
      for (const chat of ['p:here:~', 'p:desk:repo']) expect(mail.known(chat)).toBe(chat)
      for (const chat of [undefined, '', 'repo', 'p:here:old', 'SHE-9/Agent', 'p:desk:invented', 'p:desk:repo/Agent', ' p:here:~']) expect(mail.known(chat)).toBeUndefined()
      // records are this installation's own, never another user's
      expect(new RequestedNewsMailbox(someoneElse.root).known('p:here:~')).toBeUndefined()
    } finally {
      mine.done()
      someoneElse.done()
    }
  })
})

describe('news that waits on disk', () => {
  test('keeps its order across a restart, waits for a failed delivery, and is delivered once', async () => {
    const mine = installation()
    try {
      const writer = new RequestedNewsMailbox(mine.root)
      writer.post(note('p:small:repo'))
      writer.post(note('p:small:repo', { text: 'SHE-1 needs you', event: 'needs-you' }))
      writer.post(note('p:small:repo', { text: 'SHE-1 was merged', event: 'merged' }))
      // a restarted server asks again: another installation owns none of it
      let delivered = 0
      await new RequestedNewsMailbox(mine.root).drain(() => false, async () => void delivered++)
      expect(delivered).toBe(0)
      // a delivery that fails stops the drain; nothing is half-taken
      await expect(new RequestedNewsMailbox(mine.root).drain((chat) => chat === 'p:small:repo', async () => {
        throw new Error('the coordinator is offline')
      })).rejects.toThrow('offline')
      expect(readdirSync(join(mine.root, 'requested-news'))).toHaveLength(3)
      const got: RequestedNews[] = []
      await new RequestedNewsMailbox(mine.root).drain((chat) => chat === 'p:small:repo', async (n) => void got.push(n))
      expect(got.map((n) => n.event)).toEqual(['ready', 'needs-you', 'merged'])
      expect(got.map((n) => n.task)).toEqual(['SHE-1', 'SHE-1', 'SHE-1'])
      expect(readdirSync(join(mine.root, 'requested-news'))).toEqual([])
      // and nothing is delivered twice
      await new RequestedNewsMailbox(mine.root).drain(() => true, async () => void delivered++)
      expect(delivered).toBe(0)
    } finally {
      mine.done()
    }
  })

  test("another installation's mail is neither read nor deleted", async () => {
    const mine = installation()
    try {
      new RequestedNewsMailbox(mine.root).post(note('p:far:shop'))
      let delivered = 0
      await new RequestedNewsMailbox(mine.root).drain((chat) => chat === 'p:small:repo', async () => void delivered++)
      expect(delivered).toBe(0)
      expect(readdirSync(join(mine.root, 'requested-news'))).toHaveLength(1)
    } finally {
      mine.done()
    }
  })
})
