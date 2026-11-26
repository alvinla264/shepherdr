// What an agent reports about itself, as the chat keeps it: observations only, never a launch preference or a
// catalog default.
import { describe, expect, test } from 'bun:test'
import { codexRuntime } from '../server/live/codex-runtime.ts'
import type { LogEvent } from '../server/live/readers/types.ts'
import { sessionRuntime } from '../server/live/runtime.ts'

const file = '/logs/agent.jsonl'
const session = (f: string, at: number): LogEvent => ({ kind: 'session', id: `session-${at}`, at, sessionId: `s-${at}`, file: f })
const runtime = (at: number, r: { model?: string; effort?: string }, f = file, replace = false): LogEvent =>
  ({ kind: 'runtime', id: `runtime-${at}`, at, file: f, ...(replace ? { replace } : {}), runtime: { source: 'session', at, ...r } })

describe('session runtime', () => {
  test('merges what the CLI reports, a changed model dropping the level it was on', () => {
    const ev = [runtime(10, { model: 'gpt-6-sol', effort: 'high' })]
    expect(sessionRuntime(ev, file, 0)).toMatchObject({ model: 'gpt-6-sol', effort: 'high' })
    // another model: its effort is not the previous model's
    expect(sessionRuntime([...ev, runtime(20, { model: 'gpt-6.1-sol' })], file, 0)).toMatchObject({ model: 'gpt-6.1-sol' })
    expect(sessionRuntime([...ev, runtime(20, { model: 'gpt-6.1-sol' })], file, 0)!.effort).toBeUndefined()
    // the same model: a level it reports now is kept with it
    expect(sessionRuntime([...ev, runtime(20, { effort: 'low' })], file, 0)).toMatchObject({ model: 'gpt-6-sol', effort: 'low' })
  })

  test('a turn context replaces the whole snapshot, so an unset level is not the last turn’s', () => {
    const ev = [runtime(10, { model: 'gpt-6-sol', effort: 'high' }), runtime(20, { model: 'gpt-6-sol' }, file, true)]
    expect(sessionRuntime(ev, file, 0)).toEqual({ source: 'session', at: 20, model: 'gpt-6-sol' })
  })

  test('reads only this launch, from its own file: an old log or another session supplies nothing', () => {
    expect(sessionRuntime([runtime(10, { model: 'old-model' })], file, 100)).toBeUndefined()
    expect(sessionRuntime([runtime(10, { model: 'other' }, '/logs/other.jsonl')], file, 0)).toBeUndefined()
    // the file starts again: what it said before this session is not what it says now
    expect(sessionRuntime([runtime(10, { model: 'before' }), session(file, 20)], file, 0)).toBeUndefined()
    expect(sessionRuntime([runtime(10, { model: 'before' }), session(file, 20), runtime(30, { model: 'after' })], file, 0)).toMatchObject({ model: 'after' })
  })

  test('nothing reported is nothing known', () => {
    expect(sessionRuntime([], file, 0)).toBeUndefined()
    expect(sessionRuntime([session(file, 10)], file, 0)).toBeUndefined()
  })
})

describe('a codex thread read', () => {
  test('keeps a loaded thread’s model and level; a thread that is not loaded says nothing', () => {
    expect(codexRuntime({ model: 'gpt-6-sol', reasoningEffort: 'high', status: { type: 'idle' } }, 5)).toEqual({ source: 'session', at: 5, model: 'gpt-6-sol', effort: 'high' })
    expect(codexRuntime({ model: 'gpt-6-sol', status: { type: 'notLoaded' } }, 5)).toBeUndefined()
    expect(codexRuntime({ model: 'gpt-6-sol' }, 5)).toBeUndefined()
  })

  test('"default" and a null level are not values it can report', () => {
    // null means unset or unavailable in its protocol, never a known default
    expect(codexRuntime({ model: 'default', reasoningEffort: null, status: { type: 'idle' } }, 5)).toEqual({ source: 'session', at: 5 })
  })
})
