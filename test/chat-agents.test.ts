// Chat agents: a chat needs a CLI whose log Shepherdr can find and read, so Settings, the restart sheet and the CLI
// itself offer Claude Code, Codex and pi, say why nothing else is there, and refuse it before anything starts.
import { describe, expect, test } from 'bun:test'
import { Agents } from '../server/live/agents.ts'
import { LOG_FINDERS } from '../server/live/readers/find.ts'
import { CHAT_KINDS, chatProblem, readerFor } from '../server/live/readers/index.ts'
import { harnessProblem, restartInfo } from '../server/live/restart.ts'
import { CATALOG, KIND, REVIEWERS, Settings } from '../server/live/settings.ts'

const row = (key: string) => CATALOG.flatMap((s) => s.rows).find((r) => r.key === key)!
const fresh = () => new Settings({ everywhere: {}, machine: {}, spaces: {} })

describe('which CLIs can hold a chat', () => {
  test('the ones with both a runtime log finder and a reader, by their herdr kind', () => {
    expect(CHAT_KINDS).toEqual(['claude', 'codex', 'pi'])
    for (const kind of CHAT_KINDS) {
      expect(readerFor(kind)).toBeDefined()
      expect(LOG_FINDERS[kind]).toBeFunction()
    }
    // the older names still find theirs; a CLI without a reader says so in plain words
    expect(readerFor('claude-code')).toBeDefined()
    expect(readerFor('gemini')).toBeUndefined()
    expect(chatProblem('gemini')).toBe('gemini does not support Shepherdr chat: no chat log reader is available. Choose claude, codex, pi. Headless review support is separate.')
    expect(chatProblem('pi')).toBeUndefined()
  })

  test('Settings offers those only for Tasks, Coordinators and Backup; another is refused and saves nothing', () => {
    const settings = fresh()
    for (const key of ['task.agent', 'coordinator.agent', 'task.fallback']) {
      expect(row(key).options!.filter((v) => v !== 'off')).toEqual(['Claude Code', 'Codex', 'pi'])
      const was = settings.get(key)
      for (const value of ['Gemini', 'Cursor', 'Antigravity']) {
        expect(settings.set(key, value)).toMatchObject({ ok: false, error: expect.stringContaining('no chat log reader') })
        expect(settings.get(key)).toBe(was)
      }
    }
    expect(settings.set('task.fallback', 'off').ok).toBe(true)
    // a choice saved before this rule stays readable, but starting on it is refused (below)
    expect(new Settings({ everywhere: { 'task.agent': 'Antigravity' }, machine: {}, spaces: {} }).get('task.agent')).toBe('Antigravity')
    // headless reviewers are their own list, and unchanged
    expect(REVIEWERS).toEqual(['Codex', 'Claude Code', 'pi'])
    expect(settings.set('reviewer.agent', 'Codex').ok).toBe(true)
    expect(KIND['pi']).toBe('pi')
  })

  test('a launch or restart on another CLI fails first, with no callback run and no record made', async () => {
    const agents = new Agents()
    try {
      const spec = { key: 'gemini-chat', name: 'gemini-chat', kind: 'gemini', cwd: '/tmp', workspace: 'test' }
      let stopped = false
      await expect(agents.ensure(spec)).rejects.toThrow('no chat log reader')
      await expect(agents.restart(spec, async () => void (stopped = true))).rejects.toThrow('no chat log reader')
      expect(stopped).toBe(false)
      expect(agents.record(spec.key)).toBeUndefined()
    } finally {
      agents.stop()
    }
  })

  test('a relaunch lets its own start callback replace the agent', async () => {
    const agents = new Agents()
    let launched = 0
    // the launch itself belongs to herdr; here only the handover through ensure is under test
    ;(agents as unknown as { launch: (s: unknown) => Promise<null> }).launch = async () => (launched++, null)
    try {
      const spec = { key: 'relaunch-chat', name: 'relaunch-chat', kind: 'codex', cwd: '/tmp', workspace: 'test' }
      await agents.relaunch(spec.key, false, () => agents.ensure(spec))
      expect(launched).toBe(1)
    } finally {
      agents.stop()
    }
  })

  test('a launch whose owner stopped during preparation never starts', async () => {
    const agents = new Agents()
    const spec = { key: 'late-worker', name: 'late-worker', kind: 'codex', cwd: '/tmp', workspace: 'test' }
    let prepared = false
    agents.prepare = async (s) => {
      prepared = true
      return { ...s, env: {}, isolation: { run: 'run-1', home: '/tmp/late', control: '/tmp/control', path: '/tmp/late/wrapper' } }
    }
    agents.launchAllowed = () => {
      if (prepared) throw new Error('This Autopilot run has stopped.')
    }
    try {
      await expect(agents.ensure(spec)).rejects.toThrow('has stopped')
      expect(agents.record(spec.key)).toBeUndefined()
    } finally {
      agents.stop()
    }
  })

  test('the restart sheet lists readable kinds only, while a chat already on one without a reader still says what it runs', () => {
    const info = restartInfo({ role: 'task', on: { kind: 'gemini' }, want: { kind: 'codex' }, kinds: ['gemini', 'cursor', 'claude', 'codex', 'pi'], working: false })
    expect(info.on.kind).toBe('gemini')
    expect(info.clis.map((c) => c.kind)).toEqual(['claude', 'codex', 'pi'])
    expect(harnessProblem({ kind: 'gemini' })).toContain('no chat log reader')
    expect(harnessProblem({ kind: 'gemini' })).toContain('Headless review support is separate')
  })
})
