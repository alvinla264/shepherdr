// Autopilot's trusted side: which harnesses it can isolate, the run's state and shared limits, the command allowlist,
// the isolated paths and addresses, and the Settings it reads into a run. No namespaces, agents or providers.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOPILOT_KINDS, PilotRuns, hostList, pilotCommand, pilotProblem, reserveTraffic, type PilotConfig, type PilotRun } from '../server/live/autopilot.ts'
import { capturedTranscript, privateRuntimePath, publicAddress, sandboxArgs } from '../server/live/autopilot-sandbox.ts'
import { Settings } from '../server/live/settings.ts'
import { ROOT } from '../server/root.ts'

const config = (over: Partial<PilotConfig> = {}): PilotConfig => ({ harness: { kind: 'codex' }, hosts: ['api.openai.com'], secrets: [], approvals: ['merge'], parallel: 3, ...over })
const run = (over: Partial<PilotRun> = {}): PilotRun => ({ id: 'run-1', place: 'p:box:gtm', config: config(), started: 1_000, state: 'on', tasks: [], used: 0, ...over })

describe('what can run isolated', () => {
  test('only the CLIs that read a chat log here; anything else fails closed with a reason', () => {
    expect(AUTOPILOT_KINDS.sort()).toEqual(['claude', 'codex', 'pi'])
    for (const kind of AUTOPILOT_KINDS) expect(pilotProblem(kind)).toBeUndefined()
    expect(pilotProblem('gemini')).toContain('does not support Shepherdr chat')
  })

  test('a network allowlist takes exact public host names, never a URL, wildcard or local address', () => {
    expect(hostList('API.OpenAI.com, chatgpt.com api.openai.com')).toEqual(['api.openai.com', 'chatgpt.com'])
    for (const bad of ['https://api.openai.com', '*.openai.com', 'localhost', '127.0.0.1', 'api.openai.com/path', '']) {
      if (bad === '') expect(hostList(bad)).toEqual([])
      else expect(() => hostList(bad)).toThrow('exact public host names')
    }
  })
})

describe('a run and its shared limits', () => {
  test('it starts, claims only its own tasks while on, and reports a stopped run as it stopped', () => {
    const runs = new PilotRuns()
    runs.runs = []
    const r = runs.begin('p:box:gtm', config(), 100)
    expect(r.state).toBe('starting')
    expect(() => runs.claim(r, 'ABC-1')).toThrow('not accepting new tasks')
    r.state = 'on'
    runs.claim(r, 'ABC-1')
    runs.claim(r, 'ABC-1')
    expect(r.tasks).toEqual(['ABC-1'])
    expect(runs.owner('ABC-1')).toBe(r)
    expect(runs.current('p:box:gtm')).toBe(r)
    const failed = run({ state: 'failed', error: 'Server restarted.' })
    expect(() => runs.check(failed, 0)).toThrow('Server restarted.')
    expect(() => runs.check(run({ state: 'stopped' }), 0)).toThrow('Autopilot is stopped.')
  })

  test('elapsed runtime, gateway traffic, reported tokens and parallel tasks each stop it at the line', () => {
    const check = (r: PilotRun, active = 0, now = 2_000) => new PilotRuns().check(r, active, now)
    expect(() => check(run({ config: config({ runtime: 1_000 }), started: 0 }), 0, 999)).not.toThrow()
    expect(() => check(run({ config: config({ runtime: 1_000 }), started: 0 }), 0, 1_001)).toThrow('runtime')
    expect(() => check(run({ config: config({ traffic: 10 }), traffic: 9 }))).not.toThrow()
    expect(() => check(run({ config: config({ traffic: 10 }), traffic: 10 }))).toThrow('network')
    expect(() => check(run({ config: config({ tokens: 10 }), used: 9 }))).not.toThrow()
    expect(() => check(run({ config: config({ tokens: 10 }), used: 10 }))).toThrow('token')
    expect(() => check(run({ config: config({ parallel: 2 }) }), 1)).not.toThrow()
    expect(() => check(run({ config: config({ parallel: 2 }) }), 2)).toThrow('maximum parallel')
    // the gateway counts before bytes leave, and never past the allowance
    const t = run({ config: config({ traffic: 100 }) })
    reserveTraffic(t, 60)
    reserveTraffic(t, 40)
    expect(t.traffic).toBe(100)
    expect(() => reserveTraffic(t, 1)).toThrow('network')
    expect(t.traffic).toBe(100)
    expect(() => reserveTraffic(run({ state: 'stopped' }), 1)).toThrow('has stopped')
  })

  test('a wake records its reason and outcome; a transition is one at a time per place', async () => {
    const runs = new PilotRuns()
    const r = run()
    runs.wake(r, 'Schedule', 5_000)
    expect(r.last).toEqual({ at: 5_000, reason: 'Schedule', outcome: 'Queued' })
    runs.outcome(r, 'Delivered')
    runs.outcome(r, 'Turn ended', true)
    expect(r.last).toEqual({ at: 5_000, reason: 'Schedule', outcome: 'Turn ended', ended: expect.any(Number) })
    expect(() => runs.wake(run({ state: 'stopped' }), 'Run now', 6_000)).toThrow('Autopilot is stopped.')
    const value = await runs.transition('p:box:gtm', async () => {
      expect(runs.busy('p:box:gtm')).toBe(true)
      await expect(runs.transition('p:box:gtm', async () => 0)).rejects.toThrow('coordinator is changing')
      return 7
    })
    expect(value).toBe(7)
    expect(runs.busy('p:box:gtm')).toBe(false)
  })
})

describe("the isolated coordinator's command allowlist", () => {
  const own = () => run({ tasks: ['ABC-1'] })

  test('it reads the state it needs and drives only its own tasks', () => {
    const r = own()
    for (const args of [['task', 'list'], ['task', 'show', 'ABC-1'], ['status', 'ABC-1'], ['space', 'list'], ['heartbeat'], ['progress'], ['complete', 'goal proven']]) {
      expect(() => pilotCommand(r, 'p:box:gtm', args)).not.toThrow()
    }
    expect(() => pilotCommand(r, 'ABC-1/Agent', ['progress'])).not.toThrow()
    expect(() => pilotCommand(r, 'ABC-1/Agent', ['checkpoint', 'saved the work'])).not.toThrow()
    expect(() => pilotCommand(r, 'ABC-1/Agent', ['task', 'tell', 'ABC-1', 'go on'])).not.toThrow()
    expect(() => pilotCommand(r, 'ABC-1/Agent', ['ready', 'ABC-1'])).not.toThrow()
    expect(() => pilotCommand(r, 'ABC-1/Agent', ['task', 'tell', 'OTHER-2', 'go on'])).toThrow('needs the human')
    expect(() => pilotCommand(r, 'p:box:gtm', ['checkpoint', 'x'])).toThrow('needs the human')
  })

  test('a merge needs its approval turned off; settings and anything unrelated always need the human', () => {
    expect(() => pilotCommand(own(), 'ABC-1/Agent', ['merge', 'ABC-1'])).toThrow('needs the human')
    expect(() => pilotCommand(run({ config: config({ approvals: [] }), tasks: ['ABC-1'] }), 'ABC-1/Agent', ['merge', 'ABC-1'])).not.toThrow()
    for (const args of [['setting', 'set', 'autopilot.hosts', 'x'], ['mode', 'gtm', 'regular'], ['task', 'remove', 'ABC-1'], ['automation', 'remove', 'Nightly'], ['artifact', 'new', 'a.html']]) {
      expect(() => pilotCommand(own(), 'p:box:gtm', args)).toThrow('needs the human')
    }
    // its profile's own secrets and a new task in its space are allowed; the broker checks names and ownership
    for (const args of [['secret', 'list'], ['secret', 'run', 'TOKEN', '--', 'true'], ['task', 'add', 'X', '--brief', 'Y']]) {
      expect(() => pilotCommand(own(), 'p:box:gtm', args)).not.toThrow()
    }
    // a worker finishing its turn may read and tell, but not open new work
    const workers = run({ state: 'workers', tasks: ['ABC-1'] })
    expect(() => pilotCommand(workers, 'p:box:gtm', ['task', 'list'])).not.toThrow()
    expect(() => pilotCommand(workers, 'p:box:gtm', ['task', 'add', 'X'])).toThrow()
  })
})

describe('private runtime paths', () => {
  test('a transcript keeps its session id under the private home, per CLI and role', () => {
    const root = '/run/captures'
    const uuid = '1a2b3c4d-0000-4000-8000-123456789abc'
    const file = `/home/agent/.claude/projects/-repo/${uuid}.jsonl`
    const claude = capturedTranscript(root, 'claude', file)
    expect(claude).toStartWith(`${root}/.claude/projects/`)
    expect(claude).toEndWith(`-${uuid}.jsonl`)
    expect(capturedTranscript(root, 'claude', file)).toBe(claude)
    expect(capturedTranscript(root, 'codex', file)).toStartWith(`${root}/.codex/sessions/`)
    expect(capturedTranscript(root, 'pi', file)).toStartWith(`${root}/.pi/agent/sessions/`)
    expect(capturedTranscript(root, 'claude', `/home/agent/.claude/projects/-repo/${uuid}/subagents/a.jsonl`)).toContain('/subagents/')
  })

  test('nothing outside the private home is readable, not through .. and not through a symlink', () => {
    const base = mkdtempSync(join(tmpdir(), 'shep-pilot-path-'))
    const home = join(base, 'run')
    const outside = join(base, 'outside.jsonl')
    mkdirSync(home)
    writeFileSync(join(home, 'a.jsonl'), '{}')
    writeFileSync(outside, '{}')
    expect(privateRuntimePath(home, join(home, 'a.jsonl'))).toBe(join(home, 'a.jsonl'))
    expect(privateRuntimePath(home, join(home, '..', 'outside.jsonl'))).toBeUndefined()
    symlinkSync(outside, join(home, 'b.jsonl'))
    expect(privateRuntimePath(home, join(home, 'b.jsonl'))).toBeUndefined()
  })

  test('only public addresses pass the gateway; private, loopback, link-local and multicast spaces stay out', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) expect(publicAddress(ip)).toBe(true)
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'not-an-ip']) expect(publicAddress(ip)).toBe(false)
  })

  test('a sandbox has no host home, PID space or network, and mounts the project to the right access', () => {
    const args = sandboxArgs({ cwd: '/repo/worktree', repo: '/repo', home: '/run/home', state: '/run/state', control: '/run/control', binary: '/usr/bin/codex', kind: 'codex', bun: '/usr/bin/bun', writable: true, git: ['/repo/.git'] })
    for (const flag of ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv', '--cap-drop']) expect(args).toContain(flag)
    expect(args).toContain('--ro-bind')
    expect(args.join(' ')).toContain('--bind /repo/worktree /repo/worktree')
    expect(args.join(' ')).toContain('--ro-bind /repo/.git /repo/.git')
    expect(args.join(' ')).toContain('--chdir /repo/worktree')
    expect(args.join(' ')).toContain('--setenv HOME /run/home')
    // the skills are where the system prompt names them, inside the namespace
    const withSkills = sandboxArgs({ cwd: '/repo/worktree', repo: '/repo', home: '/run/home', state: '/run/state', control: '/run/control', binary: '/usr/bin/codex', kind: 'codex', bun: '/usr/bin/bun', writable: true, skills: '/opt/shepherd/skill' })
    expect(withSkills.join(' ')).toContain(`--ro-bind /opt/shepherd/skill ${join(ROOT, 'skill')}`)
    // a read-only project is mounted as such
    expect(sandboxArgs({ cwd: '/repo/worktree', repo: '/repo', home: '/run/home', state: '/run/state', control: '/run/control', binary: '/usr/bin/codex', kind: 'codex', bun: '/usr/bin/bun', writable: false }).join(' ')).toContain('--ro-bind /repo/worktree /repo/worktree')
  })
})

describe('the Settings a run reads', () => {
  const seed = {
    everywhere: {},
    machine: { 'coordinator.agent': 'Claude Code', 'coordinator.model': 'default', 'coordinator.effort': 'default' },
    spaces: {
      gtm: {
        'autopilot.agent': 'pi',
        'autopilot.hosts': 'API.OpenAI.com, chatgpt.com',
        'autopilot.secrets': 'GITHUB_TOKEN, LINEAR_KEY',
        'autopilot.approvals': 'none',
        'autopilot.traffic': '5',
        'autopilot.tokens': '1000',
        'autopilot.runtime': '2',
        'autopilot.parallel': '7',
        'heartbeat.on': 'needs-you',
      },
    },
  }

  test('inherit the coordinator by default; otherwise take the chosen harness and the shared profile', () => {
    expect(new Settings(seed).pilot('gtm')).toMatchObject({
      harness: { kind: 'pi' },
      hosts: ['api.openai.com', 'chatgpt.com'],
      secrets: ['GITHUB_TOKEN', 'LINEAR_KEY'],
      approvals: [],
      traffic: 5 * 1048576,
      tokens: 1000,
      runtime: 2 * 60000,
      parallel: 7,
    })
    const inherit = new Settings({ everywhere: {}, machine: { 'coordinator.agent': 'Claude Code', 'coordinator.model': 'default', 'coordinator.effort': 'default' }, spaces: {} }).pilot('gtm')
    expect(inherit.harness.kind).toBe('claude')
    expect(inherit.parallel).toBe(3)
    expect(inherit.approvals).toEqual(['merge'])
  })

  test('the profile refuses what it cannot enforce: host names, secret names and unknown harnesses', () => {
    const s = new Settings({ everywhere: {}, machine: {}, spaces: {} })
    expect(s.set('autopilot.hosts', 'https://api.openai.com', { space: 'gtm' })).toMatchObject({ ok: false, error: expect.stringContaining('exact public host names') })
    expect(s.set('autopilot.secrets', 'BAD-NAME', { space: 'gtm' })).toMatchObject({ ok: false, error: expect.stringContaining('secret names') })
    expect(s.set('autopilot.agent', 'gemini', { space: 'gtm' })).toMatchObject({ ok: false })
  })
})
