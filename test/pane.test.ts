// What a pane holds, and what Shepherdr types into it: words meant for an agent only go into a pane that holds that
// agent's CLI. An agent whose CLI exited leaves its shell at the prompt, where a chat message, a tell or a go would run
// as a shell command (SHEP-324): the classifier says what is there, and every send path goes by it before typing.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paneProgram, paneState } from '../server/live/pane.ts'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-pane-'))
const { Agents } = await import('../server/live/agents.ts')
type ProcessInfo = import('../server/live/herdr.ts').ProcessInfo

/** a process in the pane's foreground, as herdr reports it */
const proc = (argv: string[], name = argv[0].split('/').pop()!) => ({ pid: 200, name, argv })

/** the shell sitting at its prompt: nothing runs in the foreground */
const shellAtPrompt = (): ProcessInfo => ({ shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [proc(['/bin/zsh'], 'zsh')] })

/** each CLI herdr starts, in the shape its pane reports it: a native binary, or npm's node/bun entry point */
const clis: [string, ProcessInfo][] = [
  ['claude', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['claude', '--resume', 'abc', '--settings', '/x.json'])] }],
  ['claude', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'])] }],
  ['codex', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['codex', 'resume', 'id'])] }],
  ['codex', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'resume', 'id'])] }],
  ['pi', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['pi'])] }],
  ['pi', { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['bun', '/home/u/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'])] }],
]

describe('what a pane holds', () => {
  test("each supported CLI, in the foreground, is the agent its chat expects", () => {
    for (const [kind, info] of clis) expect([kind, paneState(kind, info)]).toEqual([kind, 'agent'])
  })

  test('the agent it does not expect is another program, not the agent', () => {
    const codex = clis.filter(([kind]) => kind === 'codex')[0][1]
    expect(paneState('claude', codex)).toBe('other')
    expect(paneProgram(codex)).toBe('codex')
  })

  test('a shell at its prompt is a shell: what ran in it has ended', () => {
    expect(paneState('claude', shellAtPrompt())).toBe('shell')
    expect(paneState('pi', shellAtPrompt())).toBe('shell')
  })

  test('an editor, a pager or a test is something else, named for the words that say why', () => {
    const vim: ProcessInfo = { shell_pid: 100, foreground_process_group_id: 300, foreground_processes: [proc(['vim', 'a.ts'])] }
    expect(paneState('claude', vim)).toBe('other')
    expect(paneProgram(vim)).toBe('vim')
    const test34: ProcessInfo = { shell_pid: 100, foreground_process_group_id: 300, foreground_processes: [proc(['/usr/bin/bun', 'test'], 'bun')] }
    expect(paneState('codex', test34)).toBe('other')
    expect(paneProgram(test34)).toBe('bun')
  })

  test('no pane at all is gone', () => {
    expect(paneState('claude', undefined)).toBe('gone')
    expect(paneState('claude', null)).toBe('gone')
    expect(paneProgram(undefined)).toBeUndefined()
  })
})

/** an Agents with one Claude Code agent herdr says runs in pane p1, and a pane whose foreground `info` reports */
function oneAgent(info: () => Promise<ProcessInfo>) {
  const a = new Agents()
  const key = 'SHE-20/Agent'
  a.records[key] = { key, name: 'shep-she-20', kind: 'claude', cwd: '/x', workspace: 'w', logs: [], started: 0, launchId: 'L1' }
  a.live.set('shep-she-20', { agent: 'claude', agent_status: 'idle', cwd: '/x', name: 'shep-she-20', pane_id: 'p1', tab_id: 't', workspace_id: 'w' })
  // no herdr here: the pane is the fake above, and a look is all that refresh would do
  a.outbox = []
  a.refresh = async () => undefined
  const typed: string[] = []
  a.panes = {
    info,
    prompt: async (_target, text) => void typed.push(`message: ${text}`),
    text: async (_pane, text) => void typed.push(`text: ${text}`),
    keys: async (_pane, keys) => void typed.push(`keys: ${keys.join(' ')}`),
  }
  return { a, key, typed }
}

const claude: ProcessInfo = { shell_pid: 100, foreground_process_group_id: 400, foreground_processes: [proc(['claude'])] }
const vim: ProcessInfo = { shell_pid: 100, foreground_process_group_id: 300, foreground_processes: [proc(['vim', 'a.ts'])] }

describe('nothing is typed into a pane that is not the agent', () => {
  /** the next agent, on its own conversation: a new launch holds what waited for it (outbox.json, carried over) */
  function nextAgent(waited: { id: string; key: string; text: string; at: number }[]) {
    const b = new Agents()
    const key = 'SHE-20/Agent'
    b.records[key] = { key, name: 'shep-she-20', kind: 'claude', cwd: '/x', workspace: 'w', logs: [], started: 2, launchId: 'L2' }
    b.live.set('shep-she-20', { agent: 'claude', agent_status: 'idle', cwd: '/x', name: 'shep-she-20', pane_id: 'p1', tab_id: 't', workspace_id: 'w' })
    b.outbox = waited.map((o) => ({ ...o }))
    b.refresh = async () => undefined
    const typed: string[] = []
    b.panes = {
      info: async () => claude,
      prompt: async (_target, text) => void typed.push(`message: ${text}`),
      text: async (_pane, text) => void typed.push(`text: ${text}`),
      keys: async (_pane, keys) => void typed.push(`keys: ${keys.join(' ')}`),
    }
    return { b, key, typed }
  }

  test('a message to an agent whose pane shows a shell is not typed, and waits for the next agent', async () => {
    const { a, key, typed } = oneAgent(async () => shellAtPrompt())
    const sent = await a.send(key, 'Rename it to boards.')
    expect(typed).toEqual([])
    expect(sent).toMatchObject({ waiting: true, waitsFor: 'start' })
    expect(a.waiting(key).map((o) => o.text)).toEqual(['Rename it to boards.'])
    // the agent is back on its conversation: what waited goes in, after the first message the launch brings
    const next = nextAgent(a.waiting(key))
    ;(next.b as unknown as { queue: (key: string, texts: string[], ahead?: boolean) => void }).queue(next.key, ['Carrying on.'], true)
    await next.b.deliver(next.key)
    expect(next.typed).toEqual(['message: Carrying on.', 'message: Rename it to boards.'])
  }, 20_000)

  test('words meant for the agent are held, the next run gets them; a keypress is refused', async () => {
    const { a, key, typed } = oneAgent(async () => shellAtPrompt())
    expect(await a.text(key, 'boards', 'hold')).toBe('held')
    expect(typed).toEqual([])
    expect(a.waiting(key).map((o) => o.text)).toEqual(['boards'])
    await expect(a.keys(key, ['1'])).rejects.toThrow("SHE-20/Agent's terminal is at a shell, not the agent.")
    expect(typed).toEqual([])
    const next = nextAgent(a.waiting(key))
    await next.b.deliver(next.key)
    expect(next.typed).toEqual(['message: boards'])
  }, 20_000)

  test("another program in the pane is refused, and the words say which one, not the agent", async () => {
    const { a, key, typed } = oneAgent(async () => vim)
    await expect(a.text(key, 'hello', 'refuse')).rejects.toThrow("SHE-20/Agent's terminal is running vim, not the agent.")
    await expect(a.keys(key, ['1'])).rejects.toThrow('running vim, not the agent')
    await expect(a.send(key, 'hello', { cid: 'c1' })).rejects.toThrow('running vim, not the agent')
    expect(typed).toEqual([])
  })

  test('a message whose pane cannot be looked at is refused, not typed blind', async () => {
    const { a, key, typed } = oneAgent(async () => {
      throw new Error('pane.process_info: no such pane')
    })
    await expect(a.send(key, 'hello', { cid: 'c1' })).rejects.toThrow("didn't say what runs in it")
    expect(typed).toEqual([])
  })

  test('as before, an agent in its pane takes what is meant for it', async () => {
    const { a, key, typed } = oneAgent(async () => claude)
    expect(await a.text(key, 'hello', 'refuse')).toBe('typed')
    await a.keys(key, ['1'])
    await a.send(key, 'and this')
    expect(typed).toEqual(['text: hello', 'keys: 1', 'message: and this'])
  })

  test("the app's own terminal types blind: a human drives the pane and sees what it holds", async () => {
    const { a, key, typed } = oneAgent(async () => shellAtPrompt())
    await a.typeText(key, 'ls')
    await a.typeKeys(key, ['enter'])
    expect(typed).toEqual(['text: ls', 'keys: enter'])
  })
})
