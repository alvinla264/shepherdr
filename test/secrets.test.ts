// Agents' secrets: kept at a level (Everywhere, a machine, a space) in a file only you can read, picked most specific
// first, asked for with a masked card, and never in a snapshot, a chat or the command's printed answer.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-secrets-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { Vault, secretPages } = await import('../server/live/secrets.ts')
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

describe('the vault', () => {
  test('the most specific level wins, and its file is readable by you only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shep-vault-'))
    const v = new Vault(dir)
    expect(v.set('all', 'TOKEN', 'everywhere').ok).toBe(true)
    expect(v.set('p:box:api', 'TOKEN', 'for api').ok).toBe(true)
    expect(v.set('m:box', 'OTHER', 'box').ok).toBe(true)
    const chain = ['p:box:api', 'm:box', 'all']
    expect(v.pick(['TOKEN', 'OTHER', 'NONE'], chain)).toEqual({ found: { TOKEN: { value: 'for api', level: 'p:box:api' }, OTHER: { value: 'box', level: 'm:box' } }, missing: ['NONE'] })
    expect(v.pick(['TOKEN'], ['p:box:web', 'm:box', 'all']).found.TOKEN.value).toBe('everywhere')
    expect(v.visible(chain).map((x) => [x.name, x.level])).toEqual([
      ['OTHER', 'm:box'],
      ['TOKEN', 'p:box:api'],
    ])
    expect(statSync(join(dir, 'vault.json')).mode & 0o777).toBe(0o600)
    // removed: the level above counts again
    expect(v.set('p:box:api', 'TOKEN', null).ok).toBe(true)
    expect(v.pick(['TOKEN'], chain).found.TOKEN.value).toBe('everywhere')
    expect(v.set('p:box:api', 'TOKEN', null).ok).toBe(false)
  })

  test('a name is one an environment variable may have, and a value is not empty', () => {
    const v = new Vault('', {})
    expect(v.set('all', 'BAD NAME', 'x').ok).toBe(false)
    expect(v.set('all', '1TOKEN', 'x').ok).toBe(false)
    expect(v.set('all', 'TOKEN', '').ok).toBe(false)
    expect(v.set('nowhere', 'TOKEN', 'x').ok).toBe(false)
    expect(v.set('all', 'github_token', 'x').ok).toBe(true)
  })

  test("Settings gets a Secrets page for each level, with names and never a value", () => {
    const v = new Vault('', { all: { A: { value: 'shh-1', at: 1 } }, 'p:box:api': { B: { value: 'shh-2', at: 2 } } })
    const pages = secretPages([{ name: 'Tasks', rows: [], level: 'all' }, { name: 'Tasks', rows: [], level: 'p:box:api', machine: 'box' }, { name: 'Alerts', rows: [], global: true }], v.names())
    const secrets = pages.filter((p) => p.secrets)
    expect(secrets.map((p) => [p.level, p.machine, p.secrets!.map((s) => s.name)])).toEqual([
      ['all', undefined, ['A']],
      ['p:box:api', 'box', ['B']],
    ])
    expect(JSON.stringify(pages)).not.toContain('shh-')
  })
})

describe('the shepherdr secret command', () => {
  const src = new LiveSource()
  afterAll(() => src.stop())
  const home = placeId.home()
  // what the worker hands its own agent once it has found its process: this space, this machine, everywhere
  const proof = src.agents.secretAccess.issue(home, 'test-process', [home, placeId.machine(), 'all'])

  test('an agent asks with a card, and is told it is kept already', async () => {
    const r = await src.cli(['secret', 'ask', 'API_KEY', '--why', 'To call the API'], { chat: home })
    expect(r.code).toBe(0)
    const card = src.chats.log(home).posted.find((p) => p.secret?.name === 'API_KEY')!.secret!
    expect(card.why).toBe('To call the API')
    expect(card.levels.map((l) => l.id)).toEqual([home, placeId.machine(), 'all'])
    // not from a terminal: there is no chat to show the card in
    expect((await src.cli(['secret', 'ask', 'API_KEY'], {})).code).toBe(1)

    // a paste's line end goes; anything else is the secret's own
    expect(await src.act({ type: 'secret', level: placeId.machine(), name: 'API_KEY', value: 'k-123456\n' })).toEqual({ ok: true })
    await src.act({ type: 'secret', level: placeId.machine(), name: 'SPACED', value: ' pass word ' })
    expect((await src.cli(['secret', 'run', 'SPACED'], { chat: home, proof })).secrets).toEqual({ SPACED: ' pass word ' })
    expect((await src.cli(['secret', 'ask', 'API_KEY'], { chat: home })).out).toContain('kept already')
    expect((await src.cli(['secret', 'ask', 'API_KEY', '--force'], { chat: home })).code).toBe(0)
  })

  test('run and env get the values; nothing else prints or shows one', async () => {
    await src.act({ type: 'secret', level: 'all', name: 'OTHER', value: 'o-987654' })
    const r = await src.cli(['secret', 'run', 'API_KEY', 'OTHER'], { chat: home, proof })
    expect(r).toEqual({ out: '', code: 0, secrets: { API_KEY: 'k-123456', OTHER: 'o-987654' } })
    expect((await src.cli(['secret', 'env', 'API_KEY,OTHER', '--file', '.env'], { chat: home, proof })).secrets).toEqual({ API_KEY: 'k-123456', OTHER: 'o-987654' })
    const missing = await src.cli(['secret', 'run', 'NOPE'], { chat: home, proof })
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('shepherdr secret ask NOPE')

    const list = await src.cli(['secret', 'list'], { chat: home })
    expect(list.out).toContain('API_KEY')
    expect(list.out).toContain('OTHER  (Everywhere')
    const shown = JSON.stringify([list, src.snapshot(), src.chats.log(home)])
    expect(shown).not.toContain('k-123456')
    expect(shown).not.toContain('o-987654')
    expect(src.snapshot().settings.find((x) => x.name === 'Secrets' && x.level === 'all')?.secrets?.map((s) => s.name)).toEqual(['OTHER'])
    expect(readFileSync(join(process.env.SHEPHERDR_HOME!, 'vault.json'), 'utf8')).toContain('k-123456')
  })

  test('run and env need this session\u2019s credential: no proof, or one that is not current, gets nothing', async () => {
    // loopback and headers are not a credential, and neither is a chat the caller names
    for (const ctx of [{ chat: home }, { chat: home, local: false }, { chat: home, proof: '0'.repeat(64) }, { chat: home, proof: 'not-a-proof' }]) {
      const r = await src.cli(['secret', 'run', 'API_KEY'], ctx)
      expect(r.code).toBe(1)
      expect(r.secrets).toBeUndefined()
      expect(r.out).toContain('needs a current agent credential')
    }
    // a credential for a scope this worker no longer has grants nothing
    const stale = src.agents.secretAccess.issue('GTM-98/Agent', 'test-process', ['p:somewhere:else', 'all'])
    expect((await src.cli(['secret', 'run', 'API_KEY'], { chat: 'GTM-98/Agent', proof: stale })).out).toContain('scope is no longer valid')
    // nor does one that was revoked
    const revoked = src.agents.secretAccess.issue('GTM-99/Agent', 'test-process', [home, placeId.machine(), 'all'])
    src.agents.secretAccess.revoke('GTM-99/Agent')
    expect((await src.cli(['secret', 'run', 'API_KEY'], { chat: 'GTM-99/Agent', proof: revoked })).code).toBe(1)
    // names and values are still managed from a terminal, which needs no credential
    expect((await src.cli(['secret', 'list'], { chat: home })).out).toContain('API_KEY')
  })

  test('over the web address the credential is the Authorization bearer and nothing else', async () => {
    const { startApp } = await import('../server/app.ts')
    const server = startApp({ source: src, dist: '/nonexistent', port: 0 })
    const run = async (headers: Record<string, string> = {}, body: object = {}) => {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/cli`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ args: ['secret', 'run', 'API_KEY'], chat: home, ...body }) })
      return (await r.json()) as { code: number; secrets?: Record<string, string> }
    }
    try {
      // straight from this machine and through a proxy that claims to be it: both need the bearer
      const none: Record<string, string>[] = [{}, { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'tailscale-user-login': 'me' }, { authorization: 'Bearer nope' }]
      for (const headers of none) {
        const r = await run(headers)
        expect(r.code).toBe(1)
        expect(r.secrets).toBeUndefined()
      }
      expect((await run({ authorization: `Bearer ${proof}` })).secrets).toEqual({ API_KEY: 'k-123456' })
      // naming another chat in the body does not reach another space's secrets
      await src.act({ type: 'secret', level: 'p:other:private', name: 'ONLY_THERE', value: 'other-value' })
      expect((await run({ authorization: `Bearer ${proof}` }, { args: ['secret', 'env', 'ONLY_THERE'], chat: 'p:other:private', cwd: '/elsewhere' })).code).toBe(1)
      expect((await run({ authorization: `Bearer ${proof}` }, { chat: 'p:other:private', cwd: '/elsewhere' })).secrets).toEqual({ API_KEY: 'k-123456' })
    } finally {
      server.stop(true)
    }
  })

  test('the human sets and removes one from a terminal, its value on stdin', async () => {
    expect((await src.cli(['secret', 'set', 'TYPED'], {})).code).toBe(1)
    expect((await src.cli(['secret', 'set', 'TYPED', '--machine'], { stdin: 'v-1\n' })).out).toContain('Saved TYPED')
    expect((await src.cli(['secret', 'run', 'TYPED'], { chat: home, proof })).secrets).toEqual({ TYPED: 'v-1' })
    expect((await src.cli(['secret', 'rm', 'TYPED', '--machine'], {})).code).toBe(0)
    expect((await src.cli(['secret', 'run', 'TYPED'], { chat: home, proof })).code).toBe(1)
  })
})
