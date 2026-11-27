// The live-session guard (docs/guard.md): the pure policy that refuses the few commands that would take the running
// Shepherdr and herdr down, the wrappers that never reach the real command when they refuse, and the launch that puts
// the guard first on every agent's PATH. Nothing here can touch this machine's live session: the "real" commands are
// stubs in a temporary folder that only record their arguments.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUARD_COMMANDS, agentEnv, guardDir, guarded } from '../server/live/box.ts'
import { helperFiles } from '../server/live/install.ts'
import { coordinatorPrompt, taskPrompt } from '../server/live/prompts.ts'

const root = join(import.meta.dir, '..')
const guard = join(root, 'bin', 'guard')
const script = join(guard, '.guard')

/** what the pure policy says: guard_verdict COMMAND ARG…, sourced so that only it runs */
function policy(command: string, args: string[]) {
  const r = spawnSync('sh', ['-c', '. "$1" || exit 2; shift; if guard_verdict "$@"; then printf "ALLOW"; else printf "REFUSE %s" "$guard_reason"; exit 1; fi', 'sh', script, command, ...args], { encoding: 'utf8' })
  return { said: r.stdout, code: r.status }
}

const ALLOWED: [string, string[]][] = [
  ['systemctl', ['--user', 'status', 'herdr.service']],
  ['systemctl', ['--user', 'set-property', 'herdr.service', 'CPUWeight=1000']],
  ['systemctl', ['--user', 'restart', 'some-other.service']],
  ['systemctl', ['--user', 'list-units']],
  ['pkill', ['-f', 'vite']],
  ['pkill', ['sleep']],
  ['pkill', ['-f', 'SomeTestName']],
  ['killall', ['chrome']],
  ['killall', ['my-server']],
  ['herdr', ['status']],
  ['herdr', ['pane', 'list']],
  ['herdr', ['agent', 'start', 'pi']],
  ['herdr', ['session', 'list']],
  ['herdr', ['--session', 'work', 'pane', 'list']],
  ['pkill', ['-u', 'alvin', 'sleep']],
  ['shepherdr', ['--url', 'http://127.0.0.1:7791', 'task', 'list']],
  ['shepherdr', ['task', 'list']],
  ['shepherdr', ['restart', 'SHE-12']],
  ['shepherdr', ['set', 'heartbeat.when', 'RRULE:FREQ=DAILY']],
  ['shepherdr', ['secret', 'ask', 'GITHUB_TOKEN', '--why', 'to open pull requests']],
  ['shepherdr', ['merge', 'SHE-12']],
  ['shepherdr', ['doctor']],
  ['ls', ['-la']],
]

const REFUSED: [string, string[]][] = [
  ['systemctl', ['--user', 'stop', 'herdr.service']],
  ['systemctl', ['--user', 'restart', 'herdr-core.service']],
  ['systemctl', ['--user', 'mask', 'shepherdr.service']],
  ['systemctl', ['--user', 'kill', '-s', 'KILL', 'hc-serve-123.service']],
  ['systemctl', ['--user', 'stop', '--all']],
  ['systemctl', ['--user', 'isolate', 'herdr.service']],
  ['systemctl', ['--user', 'disable', '--now', 'herdr.service']],
  ['systemctl', ['--user', 'stop', '*']],
  ['systemctl', ['--user', 'restart', 'herdr.se*']],
  ['pkill', ['bun']],
  ['pkill', ['-9', '-f', 'herdr']],
  ['pkill', ['-f', 'bun server/main.ts']],
  ['pkill', ['-f', 'server/main.ts']],
  ['pkill', ['-f', '.']],
  ['killall', ['-r', '.*']],
  ['killall', ['herdr']],
  ['killall', ['bun', 'sleep']],
  ['pkill', ['-f', 'herdr', '-u', 'alvin']],
  ['herdr', ['server', 'stop']],
  ['herdr', ['--session', 'live', 'server', 'stop']],
  ['herdr', ['session', 'stop', 'work']],
  ['herdr', ['session', 'delete', 'work']],
  ['herdr', ['update']],
  ['herdr', ['start']],
  ['herdr', ['stop']],
  ['herdr', ['--session', 'live', 'restart']],
  ['shepherdr', ['update']],
  ['shepherdr', ['install']],
  ['shepherdr', ['uninstall']],
  ['shepherdr', ['migrate']],
  ['shepherdr', ['web']],
  ['shepherdr', ['secrets']],
  ['shepherdr', ['--url', 'http://127.0.0.1:7791', 'update']],
  ['shepherdr', ['secret', 'set', 'GITHUB_TOKEN']],
  ['shepherdr', ['secret', 'rm', 'GITHUB_TOKEN']],
]

describe('the guard policy', () => {
  test('lets ordinary use through', () => {
    for (const [command, args] of ALLOWED) expect([command, ...args, policy(command, args)]).toEqual([command, ...args, { said: 'ALLOW', code: 0 }])
  })

  test('refuses each way to take the live session down, with a reason', () => {
    for (const [command, args] of REFUSED) {
      const said = policy(command, args)
      expect([command, ...args, said.code]).toEqual([command, ...args, 1])
      expect(said.said.startsWith('REFUSE ')).toBe(true)
      expect(said.said.trim().length).toBeGreaterThan('REFUSE '.length)
    }
  })
})

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** real-looking commands that record what they were given, in a temporary folder */
function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-guard-'))
  made.push(dir)
  const real = join(dir, 'real')
  const calls = join(dir, 'calls')
  mkdirSync(real)
  for (const command of GUARD_COMMANDS) {
    writeFileSync(join(real, command), `#!/bin/sh\nprintf '%s\\n' "called $*" >> ${JSON.stringify(calls)}\nprintf 'path %s\\n' "$PATH" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 })
    chmodSync(join(real, command), 0o755)
  }
  const env = { HOME: dir, PATH: `${guard}:${real}:/usr/bin:/bin`, SHEPHERDR_GUARD_PATH: `${real}:/usr/bin:/bin`, SHEPHERDR_CHAT: 'SHE-21/Agent' }
  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
  return { dir, real, calls, env, called }
}

describe('the guard wrappers', () => {
  test('a refusal runs nothing, and says who refused it', () => {
    for (const [command, args] of REFUSED) {
      const s = stubs()
      const r = spawnSync(join(guard, command), args, { env: s.env, encoding: 'utf8' })
      expect([command, ...args, r.status]).toEqual([command, ...args, 1])
      expect(r.stderr).toContain('SHE-21/Agent refused')
      expect(r.stderr).toContain('The human can run it')
      // one plain line
      expect(r.stderr.split('\n').filter(Boolean)).toHaveLength(1)
      // and the real command never heard of it
      expect(s.called()).toBe('')
    }
  })

  test('ordinary use reaches the real command, with its arguments untouched and the guard still first on PATH', () => {
    const s = stubs()
    for (const [command, args] of ALLOWED) {
      if (!(GUARD_COMMANDS as readonly string[]).includes(command)) continue
      const r = spawnSync(join(guard, command), args, { env: s.env, encoding: 'utf8' })
      expect([command, ...args, r.status]).toEqual([command, ...args, 0])
      expect(s.called()).toContain(`called ${args.join(' ')}\n`)
      expect(s.called()).toContain(`path ${guard}:${s.real}:/usr/bin:/bin\n`)
    }
  })

  test('a shell finds the guard when the agent PATH starts with it', () => {
    const s = stubs()
    // by PATH, as an agent's shell runs it: `systemctl …`, not its full path
    const refused = spawnSync('sh', ['-c', 'systemctl --user stop herdr.service'], { env: s.env, encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('SHE-21/Agent refused')
    expect(s.called()).toBe('')
    expect(spawnSync('sh', ['-c', 'herdr status'], { env: s.env, encoding: 'utf8' }).status).toBe(0)
    expect(s.called()).toContain('called status\n')
  })

  test('without the PATH it guards it runs nothing rather than itself', () => {
    const s = stubs()
    const env = { ...s.env }
    delete (env as Partial<typeof env>).SHEPHERDR_GUARD_PATH
    const r = spawnSync('sh', ['-c', 'systemctl --user status herdr.service'], { env, encoding: 'utf8' })
    expect(r.status).toBe(127)
    expect(r.stderr).toContain('cannot find the real systemctl')
    expect(s.called()).toBe('')
  })
})

describe('the launch', () => {
  test("puts the guard directory first on an agent's PATH, with the PATH it guards beside it", () => {
    const before = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      const env = agentEnv('SHE-21/Agent', '/opt/shepherdr')
      expect(env.PATH.split(':')[0]).toBe(guardDir('/opt/shepherdr/bin'))
      expect(env.PATH).toBe('/opt/shepherdr/bin/guard:/opt/shepherdr/bin:/usr/bin:/bin')
      expect(env.SHEPHERDR_GUARD_PATH).toBe('/opt/shepherdr/bin:/usr/bin:/bin')
      // another machine: the helper's own copy, first on that machine's PATH too
      expect(guarded('/home/me/.shepherdr/helper/bin/guard', '/home/me/.shepherdr/helper/bin:/usr/bin')).toEqual({ PATH: '/home/me/.shepherdr/helper/bin/guard:/home/me/.shepherdr/helper/bin:/usr/bin', SHEPHERDR_GUARD_PATH: '/home/me/.shepherdr/helper/bin:/usr/bin' })
    } finally {
      process.env.PATH = before
    }
  })

  test('every guarded command is there for the launch to put on PATH, and for another machine', () => {
    for (const command of GUARD_COMMANDS) expect(existsSync(join(guard, command))).toBe(true)
    expect(readFileSync(join(guard, 'systemctl'), 'utf8')).toContain('guard_verdict')
    const files = helperFiles('linux', 'x64').filter(([to]) => to.startsWith('bin/guard/'))
    expect(files.map(([to]) => to).sort()).toEqual(GUARD_COMMANDS.map((c) => `bin/guard/${c}`).sort())
  })

  test('every agent is told about it', () => {
    const task = taskPrompt({ id: 'SHE-21', branch: 'work/21-x', base: 'main' })
    const coordinator = coordinatorPrompt({ role: 'space', name: 'shepherdr', machine: 'main' }, 'regular')
    for (const prompt of [task, coordinator]) {
      expect(prompt).toContain('live-session guard')
      expect(prompt).toContain('seatbelt, not a boundary')
    }
  })
})
