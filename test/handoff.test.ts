// What a task's next agent is handed at a switch: labelled parts (the brief, the human's first words, the living note,
// the note written at the switch, the facts), each capped by size, with an obvious credential stripped; and the living
// note kept as one card in the chat, replaced in place.
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME ??= mkdtempSync(join(tmpdir(), 'shep-handoff-'))
const { cap, handoffText, HANDOFF_CAPS, humanFirst, PACKAGE_MAX, redact, statusFacts } = await import('../server/live/handoff.ts')
const { Chats } = await import('../server/live/chats.ts')

test('a switch hands over labelled parts, in the order a reader trusts them', () => {
  const text = handoffText({
    brief: 'Say hello\n\nAdd hello.txt.',
    human: 'Use blue, not green',
    note: { text: 'hello.txt added; next the tests', by: 'Claude Code', at: 1 },
    final: 'Use blue was meant for the heading',
    commits: 'a1b2c3d Add hello.txt',
    changes: '?? more.txt',
    diffstat: 'hello.txt | 1 +',
    status: 'Its agent last said: "writing the tests" — 60% done, about 12 min left.',
  })
  const at = (s: string) => text.indexOf(s)
  expect(at('The brief as given:')).toBeGreaterThan(-1)
  expect(at('The brief as given:')).toBeLessThan(at('The human said:'))
  expect(at('The human said:')).toBeLessThan(at("The task's handoff note"))
  expect(at("The task's handoff note")).toBeLessThan(at('The agent that ran it before you wrote:'))
  expect(at('The agent that ran it before you wrote:')).toBeLessThan(at('Facts:'))
  expect(text).toContain('written by Claude Code')
  expect(text).toContain('Use blue, not green')
  expect(text).toContain('Commits on the branch so far:\na1b2c3d Add hello.txt')
  expect(text).toContain('Uncommitted changes (git status --short):\n?? more.txt')
  expect(text).toContain('What changed on the branch (git diff --stat):\nhello.txt | 1 +')
  expect(text).toContain('Its agent last said: "writing the tests"')
})

test('the note is in the package once, and the note repeated at the switch is not said twice', () => {
  const note = { text: 'hello.txt added; next the tests', by: 'Claude Code', at: 1 }
  const text = handoffText({ brief: 'Say hello', note, final: note.text })
  expect(text.match(/hello\.txt added; next the tests/g)).toHaveLength(1)
  expect(text).not.toContain('The agent that ran it before you wrote:')
})

test('each part is capped by size, so a whole package stays a few thousand characters', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
  const text = handoffText({
    brief: long(400),
    human: long(400),
    note: { text: long(400), by: 'Codex', at: 1 },
    final: long(400),
    commits: Array.from({ length: 60 }, (_, i) => `a${i} commit ${i}`).join('\n'),
    changes: Array.from({ length: 60 }, (_, i) => `?? file${i}.txt`).join('\n'),
    diffstat: Array.from({ length: 60 }, (_, i) => ` file${i}.txt | 1 +`).join('\n'),
    status: long(200),
  })
  expect(text.length).toBeLessThanOrEqual(PACKAGE_MAX)
  expect(text).toContain('(cut)')
  // a cap counts characters, never lines: a message list longer than the count is cut, not dropped
  expect(cap('x'.repeat(100), 10).length).toBeLessThanOrEqual(10)
  expect(cap('x'.repeat(100), 10)).toEndWith(' … (cut)')
  // cutting an already cut text again changes nothing
  expect(cap(cap('word '.repeat(200), 100), 100)).toBe(cap('word '.repeat(200), 100))
  expect(HANDOFF_CAPS.note).toBeLessThan(PACKAGE_MAX)
})

test('a credential is stripped from every part of the package, not just the note: the card is in the chat', () => {
  const text = handoffText({
    brief: 'Deploy with API_KEY=sk-abcdefghijklmnop1234 from the box.',
    human: 'and token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    note: { text: 'password=hunter2hunter2', by: 'Codex', at: 1 },
    commits: 'a1 Use AKIAIOSFODNN7EXAMPLE in the docs',
    status: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  })
  for (const secret of ['sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9'])
    expect(text).not.toContain(secret)
  expect(text).toContain('[redacted]')
  // what it cannot catch: a value only a reader would recognize as one
  expect(redact('the password we agreed on is written on the whiteboard')).toMatchObject({ text: 'the password we agreed on is written on the whiteboard', stripped: false })
})

test('an obvious credential is stripped, and plain words are left alone', () => {
  const key = redact('set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 while you work')
  expect(key.stripped).toBe(true)
  expect(key.text).not.toContain('ghp_')
  expect(key.text).toContain('GITHUB_TOKEN=')
  const named = redact('use password=hunter2hunter2 in the config')
  expect(named.stripped).toBe(true)
  expect(named.text).toContain('[redacted]')
  // a short one, and one after a colon, are credentials too
  expect(redact('password=hunter2').text).toBe('password=[redacted]')
  expect(redact('api_key: abc12345').text).toBe('api_key=[redacted]')
  // plain prose is never mistaken for one: no assignment, no bearer
  const plain = redact('the token bucket is empty and the tests pass')
  expect(plain.stripped).toBe(false)
  expect(plain.text).toBe('the token bucket is empty and the tests pass')
  const prose = redact('Do not change token validation. Do not change authorization handling either.')
  expect(prose).toMatchObject({ text: 'Do not change token validation. Do not change authorization handling either.', stripped: false })
})

test('the human’s first messages are kept, the brief left to its own section, within the cap', () => {
  const messages = [
    { id: '1', who: 'you' as const, text: 'Say hello\n\nAdd hello.txt.' },
    { id: '2', who: 'agent' as const, text: 'On it' },
    { id: '3', who: 'you' as const, text: 'Use blue' },
    { id: '4', who: 'you' as const, text: 'And no tests this time' },
  ]
  expect(humanFirst(messages, 'Say hello\n\nAdd hello.txt.')).toBe('Use blue\n\nAnd no tests this time')
  const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), who: 'you' as const, text: `constraint ${i} `.repeat(4) }))
  expect(humanFirst(many).length).toBeLessThanOrEqual(HANDOFF_CAPS.human)
})

test('its agent’s own status line, from what it reported', () => {
  expect(statusFacts({})).toBe('')
  expect(statusFacts({ report: { msg: 'writing tests', progress: 60, left: 12 } })).toBe('Its agent last said: "writing tests" — 60% done, about 12 min left.')
  expect(statusFacts({ said: 'Added hello.txt.' })).toBe('It reported ready: Added hello.txt.')
})

test('the living note is one card in the chat, replaced in place rather than appended', async () => {
  const agents = {
    record: () => undefined,
    waiting: () => [],
    sentLately: () => [],
    failedLately: () => [],
    holdOf: () => undefined,
    status: () => 'gone',
    info: () => undefined,
    runtime: () => undefined,
    runtimeHook: () => undefined,
    background: () => undefined,
  }
  const chats = new Chats(agents as never, (k) => k, () => 'You')
  const key = `T-${Date.now()}/Agent`
  chats.post(key, { id: 'handoff-note:T-1', card: { id: 'handoff-note:T-1', note: { text: 'first: hello.txt', by: 'Codex' }, text: 'Handoff note' } })
  chats.post(key, { id: 'handoff-note:T-1', card: { id: 'handoff-note:T-1', note: { text: 'next: the tests', by: 'Codex' }, text: 'Handoff note' } })
  const posted = chats.chat(key).messages.filter((m) => m.card?.note)
  expect(posted).toHaveLength(1)
  expect(posted[0]!.card!.note!.text).toBe('next: the tests')
})
