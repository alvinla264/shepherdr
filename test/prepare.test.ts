// Starting a linked checkout: before it replaces a running server it prepares itself (a frozen install, the screen's
// build, a check that the server's code loads), says plainly which step failed, and leaves the old server alone.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dependenciesPresent, prepare } from '../scripts/prepare.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** one thing the stand-in bun does when asked for a step */
type Step = {
  when: 'install' | 'run' | 'build'
  /** only until this file exists (else the next rule for the step) */
  unless?: string
  says?: string
  exit?: number
  make?: Record<string, string>
}

/** a scratch checkout whose `bun` plays the plan, recording each step it was asked for. Nothing here installs, builds
 *  or touches a live server or ~/.shepherdr. */
function checkout(plan: Step[]) {
  const root = mkdtempSync(join(tmpdir(), 'shep-first-start-'))
  made.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', private: true, version: 'new', dependencies: { once: '1.0.0' }, scripts: { build: 'vite build' } }))
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan))
  const bun = join(root, 'bun')
  writeFileSync(
    bun,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const [step] = process.argv.slice(2)
appendFileSync('asked', step + '\\n')
const rule = JSON.parse(readFileSync('plan.json', 'utf8')).find((r) => r.when === step && (!r.unless || !existsSync(r.unless)))
if (!rule) process.exit(0)
if (rule.says) console.error(rule.says)
for (const [path, content] of Object.entries(rule.make ?? {})) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
process.exit(rule.exit ?? 0)
`,
  )
  chmodSync(bun, 0o755)
  const asked = () => (existsSync(join(root, 'asked')) ? readFileSync(join(root, 'asked'), 'utf8').trim().split('\n') : [])
  return { root, bun, asked }
}

const installed: Step = {
  when: 'install',
  make: {
    'install-ok': 'yes',
    'node_modules/once/package.json': JSON.stringify({ main: 'index.js' }),
    'node_modules/once/index.js': '',
  },
}
const screen: Step = { when: 'run', make: { 'dist/index.html': 'the screen' } }

describe('what is already installed', () => {
  test('a package counts only with its manifest and every entry file it names', () => {
    const f = checkout([])
    expect(dependenciesPresent(f.root)).toBe(false)
    mkdirSync(join(f.root, 'node_modules/once'), { recursive: true })
    writeFileSync(join(f.root, 'node_modules/once/package.json'), JSON.stringify({ main: 'index.js' }))
    expect(dependenciesPresent(f.root)).toBe(false)
    writeFileSync(join(f.root, 'node_modules/once/index.js'), '')
    expect(dependenciesPresent(f.root)).toBe(true)
    // one that exports a file it does not have is not installed either
    writeFileSync(join(f.root, 'node_modules/once/package.json'), JSON.stringify({ exports: { '.': './dist/index.js' } }))
    expect(dependenciesPresent(f.root)).toBe(false)
  })
})

describe('preparing a first start', () => {
  test('installs, builds the screen and checks the server, in that order', async () => {
    const f = checkout([installed, screen])
    expect(await prepare(f.root, f.bun)).toBeNull()
    expect(f.asked()).toEqual(['install', 'run', 'build'])
    expect(existsSync(join(f.root, 'dist/index.html'))).toBe(true)
  })

  test('an old screen over a half-installed node_modules is no reason to skip the install', async () => {
    const f = checkout([installed, screen])
    mkdirSync(join(f.root, 'node_modules'))
    mkdirSync(join(f.root, 'dist'))
    writeFileSync(join(f.root, 'dist/index.html'), 'the old screen')
    expect(await prepare(f.root, f.bun)).toBeNull()
    expect(f.asked().slice(0, 2)).toEqual(['install', 'run'])
  })

  test('a healthy checkout is checked again, but neither installed nor built', async () => {
    const f = checkout([installed, screen])
    expect(await prepare(f.root, f.bun)).toBeNull()
    const before = f.asked().length
    expect(await prepare(f.root, f.bun)).toBeNull()
    expect(f.asked().slice(before)).toEqual(['build'])
  })

  test('an install and build that look complete, but lose a nested server import, are repaired', async () => {
    const f = checkout([{ when: 'build', unless: 'install-ok', says: "youch: no such import 'nested'", exit: 1 }, installed, screen])
    mkdirSync(join(f.root, 'dist'))
    writeFileSync(join(f.root, 'dist/index.html'), 'the old screen')
    mkdirSync(join(f.root, 'node_modules/once'), { recursive: true })
    writeFileSync(join(f.root, 'node_modules/once/package.json'), JSON.stringify({ main: 'index.js' }))
    writeFileSync(join(f.root, 'node_modules/once/index.js'), '')
    expect(dependenciesPresent(f.root)).toBe(true)
    expect(await prepare(f.root, f.bun)).toBeNull()
    expect(f.asked().slice(0, 3)).toEqual(['build', 'install', 'run'])
  })
})

describe('a preparation that stops', () => {
  test('says which step failed, and stops there', async () => {
    const cases: [Step[], string, string[]][] = [
      [[{ when: 'install', says: 'registry is unreachable', exit: 1 }], 'bun install failed:\nregistry is unreachable', ['install']],
      [[{ when: 'install', make: { 'install-ok': 'yes' } }], 'bun install finished without the required dependencies', ['install']],
      [[installed, { when: 'run', says: 'vite: unexpected token in src/App.tsx', exit: 1 }], 'the build failed:\nvite: unexpected token', ['install', 'run']],
      [[installed, { when: 'run' }], 'the build failed', ['install', 'run']],
      [[installed, screen, { when: 'build', says: "youch: no such import 'nested'", exit: 1 }], "the server code doesn't load:\nyouch: no such import", ['install', 'run', 'build']],
    ]
    for (const [plan, says, asked] of cases) {
      const f = checkout(plan)
      expect(await prepare(f.root, f.bun)).toContain(says)
      expect(f.asked()).toEqual(asked)
    }
  })

  test('no installer at all is said plainly, not thrown', async () => {
    const f = checkout([])
    expect(await prepare(f.root, join(f.root, 'no-bun-here'))).toContain('bun install failed')
  })
})

describe('a start that cannot prepare', () => {
  test('leaves the server that is running alone, exits 1 and says why', async () => {
    const f = checkout([])
    // this checkout's build fails, so it can never replace anything
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'x', private: true, version: 'new', scripts: { build: 'echo broken-checkout >&2 && exit 1' } }))
    const old = join(f.root, 'old-server.ts')
    writeFileSync(
      old,
      `const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
        return Response.json(req.url.endsWith('/api/version') ? { root: '/old-checkout', version: 'old', supervisor: process.pid } : {})
      } })
      console.log(s.port)`,
    )
    const server = Bun.spawn([process.execPath, old], { stdout: 'pipe', stderr: 'pipe' })
    try {
      const reader = server.stdout.getReader()
      const first = await reader.read()
      const port = Number(new TextDecoder().decode(first.value).trim())
      reader.releaseLock()
      const command = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'plugin.ts'), 'start'], {
        env: { ...process.env, HOME: f.root, SHEPHERDR_HOME: join(f.root, 'home'), HERDR_PLUGIN_ROOT: f.root, HERDR_PLUGIN_STATE_DIR: join(f.root, 'state'), HERDR_PLUGIN_ID: '', SHEPHERDR_PORT: String(port) },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stderr] = await Promise.all([command.exited, new Response(command.stderr).text()])
      expect(code).toBe(1)
      expect(stderr).toContain('Shepherdr preparation failed')
      expect(stderr).toContain('broken-checkout')
      // the old server was never stopped, and no supervisor of the new one was left behind
      expect(server.exitCode).toBeNull()
      expect((await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok).toBe(true)
      expect(existsSync(join(f.root, 'state', 'supervisor.pid'))).toBe(false)
    } finally {
      server.kill()
      await server.exited
    }
  }, 30_000)
})
