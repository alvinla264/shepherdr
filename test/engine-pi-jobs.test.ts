// Regression coverage authored here, not executed on this machine (AGENTS.md).
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { repo, world, started } from './engine-world.ts'
import { PI_JOBS_WAIT_MS, type PiJobState } from '../server/live/readers/pi-task-state.ts'

function pending(): PiJobState {
  const now = Date.now()
  return { version: 1, paneId: 'p', socketHash: 's', sessionId: 's', pid: 1, processStart: '1', bootId: 'b',
    instance: randomUUID(), revision: 1, updatedAt: now, changedAt: now, phase: 'idle', running: 2,
    autoWake: 2, completionPending: 0, oldestStartedAt: now }
}
async function task(name: string) {
  const w = world()
  const { t, key } = await started(w, repo(), name)
  w.brief(key)
  w.status[key] = 'idle'
  return { w, t, key }
}

describe('Pi waiting is not an abandoned task', () => {
  test('pending job keeps task working, displays the reason, and rejects continuation without affecting human tell', async () => {
    const { w, t, key } = await task('pi-waiting')
    w.pi[key] = pending()
    w.engine.report(t.id, 'Build', 40, 10)
    expect(w.engine.statusOf(t)).toBe('work')
    expect(w.engine.view(t).report?.msg).toContain('Waiting on 2 background job(s)')
    const token = w.engine.nudgeState(t).observed
    const before = w.sent.length
    expect((await w.engine.nudge(t.id, 'continue', token)).skipped).toContain('Waiting on')
    expect(w.sent.length).toBe(before)
    await w.engine.tell(t.id, 'Human: stop and explain the build')
    expect(w.sent.at(-1)?.text).toBe('Human: stop and explain the build')
  })

  test('completion handoff remains waiting; final idle can be nudged once freshly inspected', async () => {
    const { w, t, key } = await task('pi-handoff')
    w.pi[key] = { ...pending(), running: 0, autoWake: 0, oldestStartedAt: 0, completionPending: 1 }
    expect(w.engine.statusOf(t)).toBe('work')
    expect((await w.engine.nudge(t.id, 'continue', w.engine.nudgeState(t).observed)).skipped).toContain('completion pending')
    Object.assign(w.pi[key]!, { completionPending: 0, revision: 2 })
    expect((await w.engine.nudge(t.id, 'continue', w.engine.nudgeState(t).observed)).skipped).toBeUndefined()
    expect(w.sent.at(-1)?.text).toBe('continue')
  })

  test('activity, resumed work, queued input, questions and blocked/stopped tasks are not automatic continuations', async () => {
    const { w, t, key } = await task('pi-guard')
    w.pi[key] = { ...pending(), running: 0, autoWake: 0, oldestStartedAt: 0 }
    const old = w.engine.nudgeState(t).observed
    w.pi[key]!.revision++ // resumed and stopped between coordinator looks
    expect((await w.engine.nudge(t.id, 'continue', old)).skipped).toContain('changed')
    w.status[key] = 'working'
    expect((await w.engine.nudge(t.id, 'continue', w.engine.nudgeState(t).observed)).skipped).toContain('working')
    w.status[key] = 'idle'
    w.chat.question = true
    expect((await w.engine.nudge(t.id, 'continue', w.engine.nudgeState(t).observed)).skipped).toContain('explicit answer')
    w.chat.question = false
    t.stopped = true
    expect((await w.engine.nudge(t.id, 'continue', w.engine.nudgeState(t).observed)).skipped).toContain('not awaiting')
  })

  test('rechecks after asynchronous preparation, not just when coordinator issued the command', async () => {
    const { w, t, key } = await task('pi-race')
    w.pi[key] = { ...pending(), running: 0, autoWake: 0, oldestStartedAt: 0 }
    const token = w.engine.nudgeState(t).observed
    w.agents.nudge = async (_key, _text, check) => {
      await Promise.resolve()
      w.pi[key]!.revision++
      return { skipped: check() }
    }
    expect((await w.engine.nudge(t.id, 'continue', token)).skipped).toContain('changed')
  })

  test('quiet background wait suppresses false stalls only within its window; over-estimate and long waits remain news', async () => {
    const { w, t, key } = await task('pi-deadline')
    const now = Date.now()
    w.pi[key] = pending()
    t.updated = now - 25 * 60_000
    w.engine.checkStalls(now)
    expect(w.news.filter((n) => n.includes('may have stalled'))).toEqual([])
    w.engine.checkStalls(now + PI_JOBS_WAIT_MS + 1)
    expect(w.news.some((n) => n.includes('inspect its job/deadline'))).toBe(true)

    const second = await task('pi-over-estimate')
    second.w.pi[second.key] = pending()
    second.w.engine.report(second.t.id, 'Building', 40, 1)
    second.t.report!.at = now - 22 * 60_000
    second.w.engine.checkStalls(now)
    expect(second.w.news.some((n) => n.includes('may have stalled'))).toBe(true)
  })
})
