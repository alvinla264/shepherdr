// What needs you: unanswered requests by original chat, Ready on its own, and coordinator questions that outlive news.
import { describe, expect, test } from 'bun:test'
import { coordinatorRequestIds } from '../shared/attention.ts'
import type { Message, Place, Snapshot, Task } from '../shared/types.ts'
import { attentionCounts } from '../src/attention.ts'

const at = (id: string, machine = 'm:one', chat = `c:${id}`) => ({ id, name: id, machine, chat, level: 2, status: 'on', mode: 'regular' }) as unknown as Place
const job = (id: string, place: string, status: Task['status'], extra: Partial<Task> = {}) => ({ id, name: id, place, status, age: '1m', sub: '', ...extra }) as unknown as Task
const world = (places: Place[], tasks: Task[], asks: Record<string, string> = {}, attentionRequests?: Record<string, string[]>) => ({ places, tasks, asks, attentionRequests }) as unknown as Snapshot

describe('attention counts', () => {
  test('counts request ids, not tasks or copies, with Ready apart and archived work left out', () => {
    const one = at('p:one'), two = at('p:two')
    const snap = world([one, two], [
      job('A-1', one.id, 'need', { agent: { chat: 'A-1/Agent' } as Task['agent'] }),
      job('A-2', one.id, 'need', { agent: { chat: 'A-2/Agent' } as Task['agent'] }),
      job('A-3', one.id, 'need', { archived: 1, agent: { chat: 'A-3/Agent' } as Task['agent'] }),
      job('B-1', two.id, 'ready'),
      job('B-2', two.id, 'ready'),
    ], {}, { 'A-1/Agent': ['q1', 'q2'], 'A-2/Agent': ['q1'], 'A-3/Agent': ['q3'], 'B-1/Agent': ['ignored'] })
    // two questions in A-1 and one in A-2 are three requests; Ready is two tasks, not their request ids
    expect(attentionCounts(snap, [one.id, two.id])).toEqual({ need: 3, ready: 2 })
    expect(attentionCounts(snap, [one.id])).toEqual({ need: 3, ready: 0 })
    // a duplicate scope, and a coordinator request repeated in its fallback, never add a second
    expect(attentionCounts(snap, [one.id, one.id, two.id])).toEqual({ need: 3, ready: 2 })
    expect(attentionCounts(world([one], [], { [one.id]: 'c1' }), [one.id])).toEqual({ need: 1, ready: 0 })
    expect(attentionCounts(snap, [])).toEqual({ need: 0, ready: 0 })
  })

  test('older machines fall back to one request per waiting task, and a task with no request id counts one', () => {
    const p = at('p:old')
    const snap = world([p], [job('OLD-1', p.id, 'need'), job('OLD-2', p.id, 'need'), job('OLD-3', p.id, 'done')], {})
    expect(attentionCounts(snap, [p.id])).toEqual({ need: 2, ready: 0 })
  })
})

describe('coordinator requests', () => {
  const ask = (id: string): Message => ({ id, who: 'agent', question: { id, kind: 'Question', title: id, choices: [], to: 'you' } })
  const news = (id: string): Message => ({ id, who: 'agent', card: { id, task: 'T-9', status: 'ready', text: 'Ready' } })

  test('a question stays open through task news and closes with an answer', () => {
    const posted = [ask('ask:first'), news('news:one'), ask('ask:second'), { id: 'quiet', who: 'agent', text: 'Disk is fine.' } as Message]
    expect(coordinatorRequestIds(posted, {}, [], false)).toEqual(['ask:first', 'ask:second'])
    expect(coordinatorRequestIds(posted, { 'ask:first': 1 }, [], false)).toEqual(['ask:second'])
    expect(coordinatorRequestIds(posted, { 'ask:first': 1, 'ask:second': 0 }, [], false)).toEqual([])
  })

  test('a native menu and a blocked CLI with nothing said are requests too', () => {
    expect(coordinatorRequestIds([], {}, ['menu:1'], true)).toEqual(['menu:1'])
    expect(coordinatorRequestIds([], {}, [], true)).toEqual(['blocked'])
    expect(coordinatorRequestIds([ask('ask:native')], {}, ['ask:native'], false)).toEqual(['ask:native'])
  })
})
