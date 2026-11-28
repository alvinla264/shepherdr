// What a restart says and offers: the hint once Settings say other than what an agent runs on, a harness in words,
// and what an agent taking over on another CLI is told.
import { describe, expect, test } from 'bun:test'
import { asRecorded, fitHarness, harnessProblem, harnessWords, launchHarness, recentChat, restartHint, restartInfo, sameHarness } from '../server/live/restart.ts'
import { setModels, TABLE } from '../server/live/models.ts'
import { finalNoteAsk, restartLine, resumedLine } from '../server/live/prompts.ts'

describe('the restart hint', () => {
  test('says the first that differs: the CLI, the model, the effort', () => {
    expect(restartHint({ kind: 'claude' }, undefined, { kind: 'codex' })).toEqual({ on: 'Claude Code', want: 'Codex' })
    expect(restartHint({ kind: 'claude', model: 'Opus 5.5' }, undefined, { kind: 'claude', model: 'claude-sonnet-5-5' })).toEqual({ on: 'Opus 5.5', want: 'Sonnet 5.5' })
    expect(restartHint({ kind: 'claude', effort: 'high' }, undefined, { kind: 'claude' })).toEqual({ on: 'high effort', want: 'default effort' })
    expect(restartHint({ kind: 'claude', model: '' }, undefined, { kind: 'claude', model: 'claude-opus-5-5' })).toEqual({ on: "Claude Code's default model", want: 'Opus 5.5' })
  })

  test('none while they agree, a model by its name or id, a level as its model takes it', () => {
    expect(restartHint({ kind: 'claude', model: 'Opus 5.5', effort: 'high' }, undefined, { kind: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toBeUndefined()
    expect(restartHint({ kind: 'claude', model: '', effort: '' }, undefined, { kind: 'claude' })).toBeUndefined()
    expect(sameHarness({ kind: 'claude', effort: 'ultra' }, { kind: 'claude', effort: 'max' })).toBe(true)
  })

  test('none while Settings say what they said when it started: a pick of its own is no change of Settings', () => {
    // started on Settings' Opus, then switched to Sonnet in the chat's + menu
    expect(restartHint({ kind: 'claude', model: 'Sonnet 5.5' }, { kind: 'claude', model: 'claude-opus-5-5' }, { kind: 'claude', model: 'claude-opus-5-5' })).toBeUndefined()
    // Settings changed since
    expect(restartHint({ kind: 'claude', model: 'Sonnet 5.5' }, { kind: 'claude', model: 'claude-opus-5-5' }, { kind: 'codex' })).toEqual({ on: 'Claude Code', want: 'Codex' })
  })
})

describe('a harness', () => {
  test('in words, and as Shepherdr passes it', () => {
    expect(harnessWords({ kind: 'codex' })).toBe('Codex')
    expect(harnessWords({ kind: 'claude', model: 'sonnet', effort: 'high' })).toBe('Claude Code (Sonnet 5.5, high)')
    expect(harnessWords({ kind: 'claude', effort: 'xhigh' })).toBe('Claude Code (xhigh)')
    expect(fitHarness({ kind: 'claude', model: 'Opus 5.5', effort: 'default' })).toEqual({ kind: 'claude', model: 'claude-opus-5-5' })
    expect(fitHarness({ kind: 'claude', model: 'default', effort: '' })).toEqual({ kind: 'claude' })
  })
})

describe('what the agent is told', () => {
  test('another CLI takes over: who ran it, and the package it left', () => {
    const chat = recentChat(
      [
        { id: '1', who: 'you', text: 'The brief', at: 1 },
        { id: '2', who: 'you', text: 'Use blue', at: 2 },
        { id: '3', who: 'agent', text: 'On it', at: 3 },
        { id: '4', who: 'agent', card: { id: 'c', text: 'Restarted' }, at: 4 },
      ] as never,
      'Claude Code',
      'The brief',
    )
    expect(chat).toBe('Human: Use blue\n\nClaude Code: On it')
    const task = restartLine({
      from: 'Claude Code',
      to: 'Codex (GPT-6-Sol, high)',
      handoff: {
        brief: 'The brief',
        human: 'Use blue',
        note: { text: 'Half done; next the tests', by: 'Claude Code', at: 1 },
        commits: 'a1 Add x',
        changes: '',
      },
    })
    expect(task).toContain('restarted this task on Codex (GPT-6-Sol, high). Claude Code ran it until now')
    expect(task).toContain('same worktree and branch')
    expect(task).toContain("The task's handoff note (written by Claude Code")
    expect(task).toContain('Commits on the branch so far:\na1 Add x')
    expect(task).toContain('Uncommitted changes (git status --short):\nnone')
    expect(task).toContain('The human said:\n\nUse blue')
    const coord = restartLine({ from: 'Claude Code', to: 'Codex', chat })
    expect(coord).toContain('restarted this chat on Codex')
    expect(coord).not.toContain('Commits')
  })

  test('the last note is asked for only at a switch, labelled as the outgoing agent’s words, and only once', async () => {
    expect(finalNoteAsk('Codex')).toContain('shepherdr handoff')
    expect(finalNoteAsk('Codex')).toContain('about to be replaced')
    const text = restartLine({ from: 'Claude Code', to: 'Codex', handoff: { brief: 'B', note: { text: 'living', by: 'Claude Code', at: 1 }, final: 'last words' } })
    expect(text).toContain('The agent that ran it before you wrote:\n\nlast words')
    expect(text.match(/living/g)).toHaveLength(1)
  })

  test('its own CLI resumes: carry on, or say nothing', () => {
    expect(resumedLine('Claude Code (Opus 5.5, high)')).toContain('<no-reply>restarted</no-reply>')
  })
})

describe('what a chat launched on', () => {
  test('is only what its CLI is really passed: nothing for one that takes no model or effort, a level its model rounds', () => {
    expect(launchHarness({ kind: 'gemini', model: 'saved-only', effort: 'high' })).toEqual({ kind: 'gemini' })
    expect(launchHarness({ kind: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toEqual({ kind: 'codex', model: 'gpt-6-luna', effort: 'max' })
    // the CLI's own are no values to show at all
    expect(launchHarness({ kind: 'claude', model: 'default', effort: 'default' })).toEqual({ kind: 'claude' })
    // a launch already given a level keeps it, though today's catalog would round it to another
    expect(asRecorded({ kind: 'codex', model: 'gpt-6-luna', effort: 'max' })).toEqual({ kind: 'codex', model: 'gpt-6-luna', effort: 'max' })
  })

  test('is its own record, never what Settings now say for its role; the catalog defaults are said plainly', () => {
    for (const role of ['task', 'coordinator'] as const) {
      const info = restartInfo({ role, on: { kind: 'codex' }, want: { kind: 'claude', model: 'sonnet', effort: 'high' }, kinds: ['claude', 'codex'], working: true })
      expect(info.on).toEqual({ kind: 'codex' })
      expect(info.want).toEqual({ kind: 'claude', model: 'claude-sonnet-5-5', effort: 'high' })
      expect(info.clis.find((c) => c.kind === 'claude')).toMatchObject({ defaultModel: 'claude-opus-5-5', defaultEffort: 'medium' })
    }
  })

  test('an older model it still takes stays pickable while it is the one launched on', () => {
    const old = { id: 'claude-opus-old', label: 'Older Opus', efforts: ['low', 'high'], effort: 'high' }
    setModels('claude', { ...TABLE.claude!, others: [old] })
    try {
      const info = restartInfo({ role: 'task', on: { kind: 'claude', model: old.id }, want: { kind: 'claude' }, kinds: ['claude'], working: false })
      expect(info.clis[0]!.models).toContainEqual({ id: old.id, label: old.label, efforts: old.efforts, defaultEffort: 'high' })
      expect(info.clis[0]!.models!.find((m) => m.id === 'claude-fable-5-1')?.defaultEffort).toBe('high')
      expect(harnessProblem({ kind: 'claude', model: old.id })).toBeUndefined()
    } finally {
      setModels('claude', undefined)
    }
  })

  test('a model it dropped, another CLI’s model, or a level it does not take is refused, never rounded silently', () => {
    expect(harnessProblem({ kind: 'codex', model: 'retired-model' })).toContain('no available model')
    expect(harnessProblem({ kind: 'codex', model: 'claude-opus-5-5' })).toContain('no available model')
    expect(harnessProblem({ kind: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toContain('does not support')
    // a CLI with no chat log reader is refused for that first, before its models are looked at
    expect(harnessProblem({ kind: 'gemini', effort: 'high' })).toContain('no chat log reader')
    expect(harnessProblem({ kind: 'gemini', model: 'default', effort: 'default' })).toContain('no chat log reader')
    // a CLI that lists its own models, and no level or model of its own, is not refused
    expect(harnessProblem({ kind: 'pi', model: 'provider/model', effort: 'high' })).toBeUndefined()
    expect(harnessProblem({ kind: 'codex', effort: 'high' })).toBeUndefined()
  })
})
