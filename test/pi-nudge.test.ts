// Real Agents delivery path against a fake Herdr socket, never a live agent.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PiJobState } from '../server/live/readers/pi-task-state.ts'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-pi-nudge-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'herdr.sock')
const { Agents } = await import('../server/live/agents.ts')
const { writeJson } = await import('../server/store.ts')
const sent: string[] = []
let unavailable = false
const server = createServer((c) => {
  let buf = ''
  c.on('data', (d) => {
    buf += d
    if (!buf.includes('\n')) return
    const { id, method, params } = JSON.parse(buf.split('\n')[0])
    if (method === 'agent.prompt') {
      if (unavailable) return void c.end(JSON.stringify({ id, error: { code: 'agent_not_ready', message: 'starting' } }) + '\n')
      sent.push(params.text)
    }
    const result = method === 'agent.list' ? { agents: [{ name: 'shep-pi', agent: 'pi', agent_status: 'idle', pane_id: 'p', tab_id: 't', workspace_id: 'w', cwd: '/w', interactive_ready: true }] } : {}
    c.end(JSON.stringify({ id, result }) + '\n')
  })
}).listen(process.env.HERDR_SOCKET_PATH)
afterAll(() => server.close())
writeJson('agents.json', { 'T-1/Agent': { key: 'T-1/Agent', name: 'shep-pi', kind: 'pi', cwd: '/w', workspace: 'w', logs: [], sessionId: 's', started: Date.now() } })

const state = () => ({ instance: '11111111-1111-1111-1111-111111111111', revision: 4, phase: 'idle', running: 0, autoWake: 0, completionPending: 0 } as PiJobState)
describe('conditional nudge delivery', () => {
  test('rechecks after input preparation and never queues a stale nudge', async () => {
    const a = new Agents()
    a.piJobs = state
    let changed = false
    a.beforeInput = async () => { changed = true }
    const before = sent.length
    try {
      expect((await a.nudge('T-1/Agent', 'continue', () => changed ? 'changed' : undefined)).skipped).toBe('changed')
      expect(sent.length).toBe(before)
      expect(a.waiting('T-1/Agent')).toEqual([])
    } finally { a.stop() }
  })
  test('only automatic nudges carry a receiver-checkable envelope; unknown state is not guessed', async () => {
    const a = new Agents()
    a.piJobs = state
    try {
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toBeUndefined()
      expect(sent.at(-1)).toBe('[[shepherdr-auto-nudge:11111111-1111-1111-1111-111111111111:4]]\ncontinue')
      await a.send('T-1/Agent', 'Human: explain the build')
      expect(sent.at(-1)).toBe('Human: explain the build')
      a.piJobs = () => undefined
      const before = sent.length
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toContain('unknown or stale')
      expect(sent.length).toBe(before)
    } finally { a.stop() }
  })
  test('a stale decision is never upgraded to a new Pi revision after its check', async () => {
    const a = new Agents()
    const pi = state()
    a.piJobs = () => pi
    const before = sent.length
    try {
      const r = await a.nudge('T-1/Agent', 'continue', () => { pi.revision++; return undefined })
      expect(r.skipped).toContain('changed during delivery')
      expect(sent.length).toBe(before)
    } finally { a.stop() }
  })
  test('a human message supersedes an automatic continuation waiting for the same agent', async () => {
    const a = new Agents()
    a.piJobs = state
    // every input preparation parks on its own barrier, so the exact interleaving can be driven
    const gates: (() => void)[] = []
    a.beforeInput = () => new Promise<void>((resolve) => gates.push(resolve))
    const fire = (at: number) => gates.splice(at, 1)[0]()
    const waitFor = async (f: () => boolean) => {
      for (let i = 0; i < 3000 && !f(); i++) await new Promise((r) => setTimeout(r, 1))
      expect(f()).toBe(true)
    }
    const before = sent.length
    const nudge = a.nudge('T-1/Agent', 'continue', () => undefined)
    await waitFor(() => gates.length === 1)
    fire(0) // the continuation passes its own preparation and queues itself
    await waitFor(() => gates.length === 1) // it now waits in delivery, on the only barrier
    const human = a.send('T-1/Agent', 'Human: stop and explain the build')
    await waitFor(() => gates.length === 2) // the human's preparation is the second barrier
    fire(1) // the human proceeds: it cancels the queued continuation and goes in
    await waitFor(() => sent.length === before + 1)
    await waitFor(() => gates.length === 1)
    fire(0) // delivery resumes: its item is gone, so nothing is sent
    const [n, h] = await Promise.all([nudge, human])
    expect(n.skipped).toBeDefined()
    expect(h.waiting).toBe(false)
    expect(sent.slice(before)).toEqual(['Human: stop and explain the build'])
    expect(a.waiting('T-1/Agent')).toEqual([])
    a.stop()
  })

  test('a continuation judged again as the request is written is refused, not sent', async () => {
    const a = new Agents()
    a.piJobs = state
    // the earlier checks pass; the one in herdr's connect handler, just before the write, refuses
    let calls = 0
    const before = sent.length
    try {
      const r = await a.nudge('T-1/Agent', 'continue', () => (++calls >= 3 ? 'task activity changed at the write' : undefined))
      expect(calls).toBe(3)
      expect(r.skipped).toContain('changed at the write')
      expect(sent.length).toBe(before)
      expect(a.waiting('T-1/Agent')).toEqual([])
      // and the agent is not left looking unready for the next attempt
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toBeUndefined()
      expect(sent.at(-1)).toBe('[[shepherdr-auto-nudge:11111111-1111-1111-1111-111111111111:4]]\ncontinue')
    } finally { a.stop() }
  })

  test('input the agent refuses drops the continuation instead of reporting it delivered', async () => {
    const a = new Agents()
    a.piJobs = state
    a.acceptInput = () => false
    const before = sent.length
    try {
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toBeDefined()
      expect(sent.length).toBe(before)
      expect(a.waiting('T-1/Agent')).toEqual([])
    } finally { a.stop() }
  })

  test('a continuation is judged once more at delivery, and a change drops it instead of queueing it', async () => {
    const a = new Agents()
    a.piJobs = state
    const before = sent.length
    let calls = 0
    try {
      const r = await a.nudge('T-1/Agent', 'continue', () => (++calls === 1 ? undefined : 'task activity changed before delivery'))
      expect(calls).toBe(2)
      expect(r.skipped).toContain('changed before delivery')
      expect(sent.length).toBe(before)
      // nothing is left behind for a later delivery
      await a.deliver('T-1/Agent')
      expect(sent.length).toBe(before)
      expect(a.waiting('T-1/Agent')).toEqual([])
    } finally { a.stop() }
  })

  test('a busy agent drops the continuation rather than holding it for later', async () => {
    const a = new Agents()
    a.piJobs = state
    a.menuUp = () => true
    const before = sent.length
    try {
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toBeDefined()
      expect(sent.length).toBe(before)
      expect(a.waiting('T-1/Agent')).toEqual([])
    } finally { a.stop() }
  })

  test('a transient refusal drops the nudge rather than delivering it after the worker resumes', async () => {
    const a = new Agents()
    a.piJobs = state
    unavailable = true
    try {
      expect((await a.nudge('T-1/Agent', 'continue', () => undefined)).skipped).toContain('not queued')
      expect(a.waiting('T-1/Agent')).toEqual([])
    } finally { unavailable = false; a.stop() }
  })
})
