// Voice talking to chats another machine owns: a call finds them, reads their history and status from the owner, sends
// with the same actions as the screen and follows their replies. The live source is real; only the peer link is
// played here. The provider socket is played in the last test. No agents, servers, microphones or provider requests.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Action, Chat, Place, Task } from '../shared/types.ts'
import { Emitter } from '../server/source.ts'

process.env.SHEPHERDR_HOME = mkdtempSync(join(tmpdir(), 'shep-voice-routing-'))
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
const { LiveSource } = await import('../server/live/source.ts')
const { Machines } = await import('../server/live/machines.ts')
const { HOST, placeId } = await import('../server/live/places.ts')

const started: InstanceType<typeof LiveSource>[] = []
afterAll(() => started.forEach((s) => s.stop()))

const space = (machine: string, name = 'project') => ({ id: `p:${machine}:${name}`, chat: `p:${machine}:${name}`, name, machine, status: 'idle' }) as Place
const chatOf = (key: string, said = ['an older line']): Chat => ({ key, cli: 'codex', working: true, messages: said.map((text, i) => ({ id: `${key}-${i}`, who: 'agent', text })) })

/** A real live source whose one peer machine, `remote`, is linked and (unless told otherwise) reachable. */
function fixture() {
  const src = new LiveSource()
  started.push(src)
  const home = placeId.home(HOST)
  const there = space('remote')
  // a second machine with a space of the same name: only the machine or the full key picks one
  const otherPlace = space('remote2')
  const task = { id: 'ABC-1', name: 'Remote job', place: there.id, state: 'working', agent: { chat: 'ABC-1/Agent' } } as Task
  const peer = { rec: { machine: 'remote', url: 'http://unreachable.invalid' }, reachable: true, snap: { places: [there], tasks: [task] }, chats: new Map<string, Chat>(), watching: { chats: [] as string[], term: null } }
  const peer2 = { rec: { machine: 'remote2', url: 'http://unreachable.invalid' }, reachable: true, snap: { places: [otherPlace], tasks: [] }, chats: new Map<string, Chat>(), watching: { chats: [] as string[], term: null } }
  const live = new Emitter<{ chat: [string, Chat] }>()
  const sent: Action[] = []
  const offered: string[] = []
  const watched = new Set<string>()
  let answer: Record<string, unknown> = { ok: true }
  // the source's own empty Machines goes; the played link replaces it
  src.peers?.stop()
  src.peers = Object.assign(new Emitter(), {
    list: () => [peer, peer2],
    owner: (key: string) => (key === there.chat || key.startsWith('ABC-1/') ? peer : key === otherPlace.chat ? peer2 : undefined),
    act: async (_l: unknown, a: Action) => {
      sent.push(a)
      return answer
    },
    rows: () => [],
    stop: () => {},
    fetch: async (_l: unknown, path: string) => {
      const key = new URL(path, 'http://peer').searchParams.get('chat')!
      offered.push(key)
      return Response.json({ chat: chatOf(key), status: 'working' })
    },
    subscribeChat: (_l: unknown, key: string, fn: (c: Chat) => void) => {
      watched.add(key)
      const off = live.on('chat', (k, c) => {
        if (k === key) fn(c)
      })
      return () => {
        watched.delete(key)
        off()
      }
    },
  }) as unknown as InstanceType<typeof LiveSource>['peers']
  src.agents.status = () => 'idle'
  return { src, peer, peer2, sent, offered, live, watched, home, there, otherPlace, answer: (a: Record<string, unknown>) => (answer = a) }
}

describe('voice in a chat another machine owns', () => {
  test("a send reaches the space, the task's agent and its reviewer as the screen's own send action", async () => {
    const f = fixture()
    await f.src.voiceTools(f.there.chat).send('hello there')
    await f.src.voiceTools('ABC-1/Agent').send('task words')
    await f.src.voiceTools('ABC-1/Reviewer').send('review words')
    expect(f.sent).toEqual([
      { type: 'send', chat: f.there.chat, text: 'hello there' },
      { type: 'send', chat: 'ABC-1/Agent', text: 'task words' },
      { type: 'send', chat: 'ABC-1/Reviewer', text: 'review words' },
    ])
  })

  test('reading asks the owning machine for that chat and its status, and names the machine', async () => {
    const f = fixture()
    const read = await f.src.voiceTools(f.there.chat).read()
    expect(f.offered).toEqual([f.there.chat])
    expect(read).toContain('remote:project is working')
    expect(read).toContain('an older line')
    expect(f.sent).toEqual([])
  })

  test('overview lists every space and open task with the machine that owns it', async () => {
    const f = fixture()
    const all = await f.src.voiceTools(f.home).overview()
    expect(all).toContain('p:remote:project (remote:project): idle')
    expect(all).toContain('remote:ABC-1 Remote job: working')
  })

  test('a name must pick exactly one chat; a machine or the full key settles it, and an unknown name never falls back', async () => {
    const f = fixture()
    const tools = f.src.voiceTools(f.home)
    await expect(tools.send('x', 'project')).rejects.toThrow('Several')
    await expect(tools.send('x', 'nonsense')).rejects.toThrow('No such chat')
    await tools.send('x', 'remote:project')
    await tools.send('y', 'remote:ABC-1')
    await tools.send('z', f.there.chat)
    expect(f.sent.map((a) => (a.type === 'send' ? a.chat : ''))).toEqual([f.there.chat, 'ABC-1/Agent', f.there.chat])
  })

  test('an unavailable machine is named as such; a send is queued here and says it never reached the agent', async () => {
    const f = fixture()
    f.peer.reachable = false
    await expect(f.src.voiceTools(f.there.chat).read()).rejects.toThrow('unavailable')
    f.answer({ waiting: true })
    expect(await f.src.voiceTools(f.there.chat).send('still here')).toContain('has not reached the agent')
  })

  test('a refusal, a wait or a queued turn from the owner is passed on in its own words', async () => {
    const f = fixture()
    f.answer({ waiting: true })
    expect(await f.src.voiceTools(f.there.chat).send('x')).toContain('once the agent has started')
    f.answer({ waiting: true, waitsFor: 'turn' })
    expect(await f.src.voiceTools(f.there.chat).send('x')).toContain('once the agent finishes this step')
    f.answer({ ok: false, error: 'The agent is gone.' })
    await expect(f.src.voiceTools(f.there.chat).send('x')).rejects.toThrow('The agent is gone.')
  })

  test('only replies that arrive during the call are read out, once, and hanging up stops following', async () => {
    const f = fixture()
    const heard: string[] = []
    const off = f.src.voiceTools(f.there.chat).onReply((text) => heard.push(text))
    // the history the call joined is a baseline: it is not read back out
    await Bun.sleep(0)
    f.live.emit('chat', f.home, chatOf(f.home, ['wrong space']))
    f.live.emit('chat', f.there.chat, chatOf(f.there.chat, ['an older line', 'the fix is in']))
    expect(heard).toEqual(['the fix is in'])
    // the same message again is not spoken twice; a longer one is a new reply
    f.live.emit('chat', f.there.chat, chatOf(f.there.chat, ['an older line', 'the fix is in']))
    f.live.emit('chat', f.there.chat, chatOf(f.there.chat, ['an older line', 'the fix is in and merged']))
    expect(heard).toEqual(['the fix is in', 'the fix is in and merged'])
    off()
    expect(f.watched.size).toBe(0)
    f.live.emit('chat', f.there.chat, chatOf(f.there.chat, ['an older line', 'the fix is in and merged', 'too late']))
    expect(heard).toHaveLength(2)
  })

  test('a chat on this machine stays local: no peer is asked, and the call listens to the same reply path', async () => {
    const f = fixture()
    const tools = f.src.voiceTools(f.home)
    expect(await tools.read()).toContain('idle')
    expect(f.offered).toEqual([])
    const off = tools.onReply(() => {})
    expect(f.watched.size).toBe(0)
    off()
  })
})

describe("a peer's chat watch", () => {
  test('a call keeps the owner sending its chat while the screen watches others, scoped to that machine, and releases it', () => {
    const f = fixture()
    // the real Machines methods over a constructed Emitter (subscribeChat listens through it), without its timers
    const m = new Emitter()
    Object.setPrototypeOf(m, Machines.prototype)
    const machines = Object.assign(m, {
      links: new Map([['remote', f.peer]]),
      voiceWatches: new Map(),
      screenWatch: { chats: [] as string[], term: null },
      owner: () => f.peer,
    }) as unknown as InstanceType<typeof Machines>
    const got: string[] = []
    const off = machines.subscribeChat(f.peer as never, 'ABC-1/Agent', (c) => got.push(c.key))
    // the screen changes what it watches, but the call's chat stays watched on its owner
    machines.watch([], null)
    expect(f.peer.watching.chats).toEqual(['ABC-1/Agent'])
    machines.emit('peerChat', 'another machine', 'ABC-1/Agent', chatOf('ABC-1/Agent'))
    machines.emit('peerChat', 'remote', 'ABC-1/Agent', chatOf('ABC-1/Agent'))
    expect(got).toEqual(['ABC-1/Agent'])
    off()
    off()
    expect(f.peer.watching.chats).toEqual([])
  })
})

describe('a voice call to the provider', () => {
  test('the reply subscription is released once, whether the provider closes or the call ends', async () => {
    const { startVoice } = await import('../server/live/voice.ts')
    const fetchWas = globalThis.fetch
    const socketWas = globalThis.WebSocket
    const keyWas = process.env.ELEVENLABS_API_KEY
    process.env.ELEVENLABS_API_KEY = 'a fake key for the socket handshake'
    writeFileSync(join(process.env.SHEPHERDR_HOME!, 'voice.json'), JSON.stringify({ agent: 'fake' }))
    let socket: FakeSocket
    class FakeSocket {
      static OPEN = 1
      readyState = 1
      onopen?: () => void
      onclose?: () => void
      onmessage?: (e: { data: string }) => void
      constructor() {
        socket = this
      }
      send() {}
      close() {
        this.onclose?.()
      }
    }
    try {
      globalThis.fetch = (async () => Response.json({ signed_url: 'ws://fake' })) as unknown as typeof fetch
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
      for (const providerCloses of [false, true]) {
        let released = 0
        const call = startVoice({ name: 'remote:test', send: async () => '', read: async () => '', overview: async () => '', onReply: () => () => released++ }, { send() {}, close() {} })
        await Bun.sleep(0)
        socket!.onopen?.()
        if (providerCloses) socket!.onclose?.()
        call.end()
        call.end()
        expect(released).toBe(1)
      }
    } finally {
      globalThis.fetch = fetchWas
      globalThis.WebSocket = socketWas
      if (keyWas === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = keyWas
    }
  })
})
