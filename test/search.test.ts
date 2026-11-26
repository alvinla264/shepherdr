// Unified search over the shared view model: scopes, stable identities, what may match, and what stays private.
import { describe, expect, test } from 'bun:test'
import { findIn } from '../plugins/chat/days.ts'
import { searchChats, searchExcerpt, searchResults } from '../plugins/keyboard/search-data.ts'
import type { Chat, Message, Place, Snapshot, Task } from '../shared/types.ts'

const place = (id: string, name: string, machine: string, chat: string, level: 0 | 1 | 2 = 2, home = false) =>
  ({ id, name, machine, chat, level, home }) as unknown as Place
const task = (id: string, name: string, placeId: string, chat: string, extra: Partial<Task> = {}) =>
  ({ id, name, place: placeId, status: 'work', age: '3m', agent: { chat } as Task['agent'], ...extra }) as unknown as Task
const snapshot = (o: Partial<Snapshot>) => ({ places: [], tasks: [], artifacts: [], machines: [], asks: {}, ...o }) as Snapshot
const chat = (key: string, messages: Message[]): Chat => ({ key, cli: 'Codex', messages })

const alpha = place('p:a', 'alpha', 'm:one', 'alpha')
const beta = place('p:b', 'beta', 'm:two', 'beta')
const snap = snapshot({
  places: [alpha, beta],
  machines: [{ machine: 'm:one', name: 'studio', status: 'on' } as unknown as Snapshot['machines'][number], { machine: 'm:two', name: 'attic', status: 'off' } as unknown as Snapshot['machines'][number]],
  tasks: [task('K-7', 'Keyboard lag', alpha.id, 'K-7/Agent', { desc: 'keys arrive twice after a sleep' }), task('K-8', 'Old notes', beta.id, 'K-8/Agent', { archived: Date.now() })],
  artifacts: [{ id: 'z4', title: 'Release checklist', place: alpha.id, by: 'home', v: 3, at: 50, when: 'now', chats: ['alpha'] } as unknown as Snapshot['artifacts'][number]],
})

describe('search scopes and identities', () => {
  test('chat, space, machine and everywhere each widen without repeating a chat', () => {
    expect(searchChats(snap, { kind: 'chat', id: 'K-7/Agent' }).map((c) => c.key)).toEqual(['K-7/Agent'])
    expect(searchChats(snap, { kind: 'space', id: alpha.id }).map((c) => c.key)).toEqual(['alpha', 'K-7/Agent'])
    const machine = searchChats(snap, { kind: 'machine', id: 'm:one' }).map((c) => c.key)
    expect(machine).toEqual(['alpha', 'K-7/Agent'])
    const all = searchChats(snap, { kind: 'all' }).map((c) => c.key)
    expect(all).toEqual(['alpha', 'beta', 'K-7/Agent', 'K-8/Agent'])
    expect(new Set(all).size).toBe(all.length)
  })

  test('a repeated space name still names its machine, and an archived task is found by its brief', () => {
    const both = snapshot({ places: [alpha, place('p:a2', 'alpha', 'm:two', 'alpha2')], machines: snap.machines })
    const hits = searchResults(both, { kind: 'all' }, 'alpha', {}).filter((h) => h.kind === 'Spaces')
    expect(hits.map((h) => h.context)).toEqual(['alpha · studio', 'alpha · attic'])
    const old = searchResults(snap, { kind: 'all' }, 'sleep', {}).find((h) => h.task === 'K-7')
    expect(old?.context).toContain('alpha · studio')
    const gone = searchResults(snap, { kind: 'all' }, 'Old notes', {}).find((h) => h.task === 'K-8')
    expect(gone?.context).toContain('Archived')
    expect(searchResults(snap, { kind: 'all' }, '', {}).some((h) => h.task === 'K-8')).toBe(false)
  })
})

describe('search messages', () => {
  const messages: Message[] = [
    { id: 'me-1', who: 'you', text: 'The [field guide](https://inside.example/secret) mentions it', at: 10 },
    { id: 'me-2', who: 'agent', file: { name: 'field guide.pdf', path: '/home/me/private.pdf' }, at: 11 },
    { id: 'me-3', who: 'agent', question: { id: 'q3', title: 'Which field guide?', kind: 'Question', choices: [], to: 'you' }, at: 12 },
    { id: 'me-4', who: 'you', text: 'field guide', waiting: true, at: 13 },
    { id: 'me-5', who: 'agent', text: `${'Padding '.repeat(70)}the field guide ends here`, at: 14 },
  ]
  const chats = { alpha: chat('alpha', messages) }

  test('matching follows chat search, keeps message ids and never reads a link target or a file path', () => {
    const hits = searchResults(snap, { kind: 'chat', id: 'alpha' }, 'FIELD GUIDE', chats).filter((h) => h.kind === 'Messages')
    expect(hits.map((h) => h.message).sort()).toEqual(findIn(messages, 'FIELD GUIDE').sort())
    expect(hits.every((h) => h.chat === 'alpha')).toBe(true)
    expect(hits.find((h) => h.message === 'me-5')?.label).toContain('the field guide')
    for (const hidden of ['inside.example', 'private.pdf']) expect(searchResults(snap, { kind: 'all' }, hidden, chats).filter((h) => h.kind === 'Messages')).toEqual([])
    expect(searchExcerpt(`${'x'.repeat(300)}the needle is here`, 'needle')).toContain('the needle is here')
  })

  test('a secret card or a blank record is not a message', () => {
    const secret: Message[] = [
      { id: 'secret-1', who: 'agent', secret: { id: 's1', name: 'DEPLOY_KEY', why: 'restricted-word', levels: [] } },
      { id: 'blank-1', who: 'agent' },
    ]
    const only = { alpha: chat('alpha', secret) }
    expect(searchResults(snap, { kind: 'all' }, '', only).filter((h) => h.kind === 'Messages')).toEqual([])
    expect(searchResults(snap, { kind: 'all' }, 'restricted-word', only)).toEqual([])
    expect(searchResults(snap, { kind: 'all' }, 'DEPLOY_KEY', only)).toEqual([])
  })

  test('all matches stay available and the newest comes first', () => {
    const many = Array.from({ length: 12 }, (_, n): Message => ({ id: `cache-${n}`, who: 'agent', text: `cache item ${n}`, at: n }))
    const hits = searchResults(snap, { kind: 'all' }, 'cache item', { alpha: chat('alpha', many) }).filter((h) => h.kind === 'Messages')
    expect(hits).toHaveLength(12)
    expect(hits[0].message).toBe('cache-11')
  })
})
