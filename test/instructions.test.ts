// Private instructions: each role's own rules, from the settings scope the human picked, on a new start or a restart.
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-instructions-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
const { Settings, setForTask } = await import('../server/live/settings.ts')
const { privatePrompt } = await import('../server/live/prompts.ts')
const { Agents, hidden } = await import('../server/live/agents.ts')
const { herdr } = await import('../server/live/herdr.ts')
const { writeJson } = await import('../server/store.ts')

const told = () => new Settings({ everywhere: {}, machine: {}, spaces: {} })

describe('where a role’s private rules come from', () => {
  test('each role follows space, then machine, then Everywhere, as one value; a blank there means none and a reset inherits again', () => {
    const s = told()
    for (const role of ['coordinator', 'task', 'reviewer'] as const) {
      const key = `${role}.instructions`
      expect(s.set(key, `${role} everywhere`).ok).toBe(true)
      expect(s.set(key, `${role} this machine`, 'machine').ok).toBe(true)
      expect(s.set(key, `${role} this space`, { space: 'one' }).ok).toBe(true)
      // the most specific one, alone: never the three joined
      expect(s.instructions(role, 'one')).toBe(`Private instructions for ${role} (from space one):\n${role} this space`)
      expect(s.instructions(role, 'two')).toContain(`${role} this machine`)
      // a blank saved here is a choice: no private rules, and nothing inherited
      expect(s.set(key, '', { space: 'one' }).ok).toBe(true)
      expect(s.instructions(role, 'one')).toEndWith('\n(none)')
      // reset: back to the machine's
      expect(s.set(key, null, { space: 'one' }).ok).toBe(true)
      expect(s.instructions(role, 'one')).toContain(`${role} this machine`)
      expect(s.set(key, null, 'machine').ok).toBe(true)
      expect(s.instructions(role, 'one')).toContain(`${role} everywhere`)
    }
  })
  test('another machine takes Everywhere from the main one and keeps its own machine and space rules', () => {
    const main = told()
    const remote = told()
    main.set('task.instructions', 'Plain words.\nShort replies.')
    remote.set('task.instructions', 'Only here.', 'machine')
    remote.set('reviewer.instructions', 'Look at local paths.', { space: 'one' })
    expect(remote.adopt(main.everywhere())).toBe(true)
    expect(remote.get('task.instructions')).toBe('Only here.')
    remote.set('task.instructions', null, 'machine')
    expect(remote.instructions('task', 'one')).toContain('Plain words.\nShort replies.')
    expect(remote.instructions('reviewer', 'one')).toContain('Look at local paths.')
    expect(remote.adopt(main.everywhere())).toBe(false)
  })
  test('the page is a compact field per role, with where its value comes from, and refuses what is too long', () => {
    const s = told()
    s.set('task.instructions', 'Personal rule.')
    s.set('task.instructions', '', { space: 'one' })
    const page = s.sections([], [], null, 'box', ['one']).find((x) => x.name === 'Private instructions' && x.level === 'p:box:one')!
    expect(page.told).toBe(true)
    expect(page.rows.map((r) => [r.key, r.multiline])).toEqual([['coordinator.instructions', true], ['task.instructions', true], ['reviewer.instructions', true]])
    expect(page.rows.find((r) => r.key === 'task.instructions')).toMatchObject({ value: '', inherits: { value: 'Personal rule.', from: 'Everywhere' } })
    expect(page.note).toContain('Saving leaves running agents alone')
    // words here never become part of a task's brief wording
    expect(page.rows.every((r) => !r.line)).toBe(true)
    expect(s.set('task.instructions', 'x'.repeat(16_001)).ok).toBe(false)
    expect(s.set('task.instructions', 'bad\0text').ok).toBe(false)
    // and a task's own --set cannot carry them
    expect('error' in setForTask('task.instructions=private')).toBe(true)
  })
})

describe('the prompt a start is given', () => {
  test('a role gets its own rules only, and a task agent’s prompt hands the reviewer snapshot on with the rules about privacy and precedence', () => {
    const s = told()
    s.set('coordinator.instructions', 'Coordinator only.')
    s.set('task.instructions', 'Task only.')
    s.set('reviewer.instructions', 'Reviewer only.')
    const coordinator = privatePrompt(s.instructions('coordinator'))
    expect(coordinator).toContain('Coordinator only.')
    expect(coordinator).not.toContain('Task only.')
    expect(coordinator).not.toContain('Reviewer only.')
    const task = privatePrompt(s.instructions('task'), s.instructions('reviewer'))
    expect(task).not.toContain('Coordinator only.')
    expect(task).toContain('Task only.')
    expect(task).toContain('Reviewer handoff only')
    expect(task).toContain('every fresh reviewer prompt')
    expect(task).toContain('This is the snapshot from your latest start; restart this task agent to refresh it')
    expect(task).toContain('Explicit human instructions and the task brief win')
    expect(task).toContain('Never copy private instructions into git')
    expect(task).toContain('Read and follow the repository/team AGENTS.md, CLAUDE.md and REVIEW.md alongside')
    expect(task).toContain('replaces earlier private instruction snapshots, including when empty')
  })
})

describe('what a launch is sent', () => {
  test('a resumed CLI with no append flag gets its snapshot again only when the words changed; a fresh start always gets it', async () => {
    const key = 'PRIVATE-1/Agent'
    const dir = mkdtempSync(join(tmpdir(), 'shep-instructions-cwd-'))
    const old = { key, name: 'shep-instructions', kind: 'codex', cwd: dir, workspace: 'private', logs: ['a.log'], sessionId: 'before', started: 0, system: 'old snapshot' }
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    try {
      for (const [was, next, again] of [
        ['old snapshot', 'new snapshot', true],
        ['old snapshot', 'old snapshot', false],
        ['old snapshot', 'Private instructions for task (from space one):\n(none)', true],
      ] as const) {
        writeJson('agents.json', { [key]: { ...old, system: was } })
        const a = new Agents()
        // the real launch's decisions, without a terminal, a route or a later delivery
        Object.assign(a, { refresh: async () => undefined, bindRoute: async () => undefined })
        try {
          await a.ensure({ ...old, system: next, first: 'Carry on.' })
          expect(a.outbox.map((o) => o.text)).toEqual(again ? [hidden(next), 'Carry on.'] : ['Carry on.'])
          expect(a.record(key)?.system).toBe(next)
        } finally { a.stop() }
      }
      expect(start).toHaveBeenCalledTimes(3)
    } finally {
      start.mockRestore()
      timer.mockRestore()
    }
  })
})
