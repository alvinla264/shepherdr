// A link that dropped and a worker that stays unwell: retry delays, thresholds and the way back, on their own,
// without a network or a second machine.
import { describe, expect, test } from 'bun:test'
import { Subscription } from '../server/live/herdr.ts'
import { LinkBackoff, WorkerHealth } from '../server/live/recovery.ts'
import { Tunnel } from '../server/live/tunnel.ts'

describe('a link that dropped', () => {
  test('each retry waits longer, from 3 to 30 seconds, and only a minute of health starts over', () => {
    const back = new LinkBackoff()
    const t = 1_000_000
    expect([back.fail(t), back.fail(t), back.fail(t), back.fail(t), back.fail(t), back.fail(t)]).toEqual([3000, 6000, 12000, 24000, 30000, 30000])
    // one good read is not a minute of it: the next failure goes on from where the delays were
    back.success(t)
    expect(back.fail(t + 1000)).toBe(30000)
    // a minute of continuous health does start over
    back.success(t + 2000)
    expect(back.fail(t + 62_000)).toBe(3000)
  })
})

describe('a worker that stays unwell', () => {
  test('it is replaced after three minutes down, then given a cooldown that doubles', () => {
    const health = new WorkerHealth()
    health.observe(false, 0)
    expect(health.restartDue(179_999)).toBe(false)
    expect(health.restartDue(180_000)).toBe(true)
    health.restarting(180_000)
    // the replacement is not torn down again at once: three minutes, then six
    expect(health.restartDue(359_999)).toBe(false)
    expect(health.restartDue(360_000)).toBe(true)
    health.restarting(360_000)
    expect(health.restartDue(719_999)).toBe(false)
    expect(health.restartDue(720_000)).toBe(true)
  })

  test('a minute of health clears the cooldown; one good answer in between does not', () => {
    const health = new WorkerHealth()
    health.observe(false, 0)
    health.restarting(200_000)
    // a good read, then failing again: the cooldown still stands
    health.observe(true, 250_000)
    health.observe(false, 260_000)
    // three minutes down, which is past the replacement it was already given: no second one before that
    expect(health.restartDue(439_999)).toBe(false)
    expect(health.restartDue(440_000)).toBe(true)
    // a minute of it, then failing: three minutes from the failure, no cooldown left
    health.observe(true, 300_000)
    health.observe(true, 361_000)
    health.observe(false, 400_000)
    expect(health.restartDue(579_999)).toBe(false)
    expect(health.restartDue(580_000)).toBe(true)
  })
})

describe('the way back from another machine', () => {
  test('an opening that fails is tried again after its delay, and stopping ends it', async () => {
    const attempts: number[] = []
    const tunnel = new Tunnel(async (_track, stopped) => {
      attempts.push(Date.now())
      // the first time ssh cannot resolve the name; after that it holds the forward open
      if (attempts.length === 1) throw new Error('ssh: Could not resolve hostname')
      await new Promise<void>((done) => {
        const timer = setInterval(() => stopped() && (clearInterval(timer), done()), 20)
      })
    })
    try {
      tunnel.start()
      expect(attempts).toHaveLength(1)
      await Bun.sleep(500)
      // not at once: it waits its backoff
      expect(attempts).toHaveLength(1)
      for (let i = 0; i < 100 && attempts.length < 2; i++) await Bun.sleep(50)
      expect(attempts).toHaveLength(2)
      expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(2900)
    } finally {
      tunnel.stop()
    }
    await Bun.sleep(100)
    expect(attempts).toHaveLength(2)
  }, 15_000)
})

describe('a subscription', () => {
  /** what a bridge connection looks like to the subscription: it is opened, writes, and one day closes */
  const fake = () => {
    const fns: Record<string, ((x?: unknown) => void)[]> = { connect: [], data: [], error: [], close: [] }
    const written: string[] = []
    const conn = {
      write: (s: string) => written.push(s),
      destroy: () => undefined,
      on: (e: string, f: (x?: unknown) => void) => void (fns[e] ??= []).push(f),
    }
    return { conn, written, fire: (e: string, x?: unknown) => (fns[e] ?? []).forEach((f) => f(x)) }
  }
  const frame = (o: object) => Buffer.from(`${JSON.stringify(o)}\n`)

  test('it is open on its first real frame, not when its process started, and a dropped one is made again', async () => {
    const conns: ReturnType<typeof fake>[] = []
    const opens: number[] = []
    const events: string[] = []
    const sub = new Subscription(
      (e) => events.push(e.event),
      () => opens.push(Date.now()),
      () => {
        const f = fake()
        conns.push(f)
        return f.conn as never
      },
    )
    sub.set([{ type: 'chat' }])
    expect(conns).toHaveLength(1)
    conns[0].fire('connect')
    expect(conns[0].written[0]).toContain('events.subscribe')
    // an ssh process is not a bridge yet: a frame is
    expect(opens).toHaveLength(0)
    conns[0].fire('data', frame({ result: {} }))
    expect(opens).toHaveLength(1)
    conns[0].fire('data', frame({ event: 'chat', data: {} }))
    expect(events).toEqual(['chat'])
    // the bridge dies: another is made, after its backoff, and opens on its own frame
    conns[0].fire('close')
    for (let i = 0; i < 100 && conns.length < 2; i++) await Bun.sleep(50)
    expect(conns).toHaveLength(2)
    conns[1].fire('connect')
    expect(opens).toHaveLength(1)
    conns[1].fire('data', frame({ event: 'snapshot', data: {} }))
    expect(opens).toHaveLength(2)
    expect(events).toEqual(['chat', 'snapshot'])
    sub.stop()
  }, 15_000)

  test('an error frame closes it rather than being counted as open', async () => {
    const conns: ReturnType<typeof fake>[] = []
    const opens: number[] = []
    const sub = new Subscription(
      () => undefined,
      () => opens.push(Date.now()),
      () => {
        const f = fake()
        conns.push(f)
        return f.conn as never
      },
    )
    sub.set([{ type: 'snapshot' }])
    conns[0].fire('connect')
    conns[0].fire('data', frame({ error: { message: 'no such subscription' } }))
    expect(opens).toHaveLength(0)
    for (let i = 0; i < 100 && conns.length < 2; i++) await Bun.sleep(50)
    expect(conns).toHaveLength(2)
    sub.stop()
  }, 15_000)
})
