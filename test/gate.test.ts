// The readiness gate itself, with launchers that are late: it must fail once, at its ceiling, with the launcher's own
// reason, and pass when the launcher becomes ready in time. No browser, no server: milliseconds.
import { describe, expect, test } from 'bun:test'
import { gate, launcher } from './gate.ts'

describe('the readiness gate', () => {
  test('waits for a fixture that is slow, however late, and passes once it is ready', async () => {
    const start = Date.now()
    let ready = false
    setTimeout(() => (ready = true), 300)
    await gate('a stand-in that takes 300 ms', () => ready, { ms: 5000 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
    expect(ready).toBe(true)
  })

  test('fails once, at its ceiling, with what it waited for and what the launcher said', async () => {
    const start = Date.now()
    const e = (await gate('the stand-in’s stream on :4321', () => false, { ms: 300, why: () => 'stderr:\nbind: address already in use' }).catch((e: Error) => e)) as Error
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
    expect(e.message).toContain('Not ready after 300 ms')
    expect(e.message).toContain('the stand-in’s stream on :4321')
    expect(e.message).toContain('bind: address already in use')
  })

  test('a probe that answers ready only after the ceiling has passed is not ready', async () => {
    const start = Date.now()
    const e = (await gate('a handshake that answers at 600 ms', () => new Promise<boolean>((r) => setTimeout(() => r(true), 600)), { ms: 300 }).catch((e: Error) => e)) as Error
    expect(Date.now() - start).toBeLessThan(600)
    expect(e.message).toContain('Not ready after 300 ms')
  })

  test('a probe that never answers ends the gate at its ceiling all the same', async () => {
    const start = Date.now()
    const e = (await gate('a port that never answers', () => new Promise<boolean>(() => undefined), { ms: 300 }).catch((e: Error) => e)) as Error
    expect(Date.now() - start).toBeLessThan(600)
    expect(e.message).toContain('Not ready after 300 ms')
  })

  test('a launcher that answers in time gives what it said', async () => {
    const out = await launcher(['sh', '-c', 'sleep 0.2; echo agent-browser 0.39.2'], (o) => /agent-browser/.test(o), { ms: 5000 })
    expect(out.trim()).toBe('agent-browser 0.39.2')
  })

  test('a launcher that says no fails with its exit code and stderr', async () => {
    const e = (await launcher(['sh', '-c', 'echo "no such browser" >&2; exit 3'], () => true, { ms: 5000 }).catch((e: Error) => e)) as Error
    expect(e.message).toContain('exited 3')
    expect(e.message).toContain('no such browser')
  })

  test('a silent launcher fails with that, at its ceiling', async () => {
    const start = Date.now()
    const e = (await launcher(['sh', '-c', 'exec sleep 5'], () => true, { ms: 300 }).catch((e: Error) => e)) as Error
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
    expect(e.message).toContain('never answered')
    expect(e.message).toContain('300 ms')
    expect(e.message).toContain('said nothing')
  })

  test('a launcher that says why and then hangs keeps what it said', async () => {
    const e = (await launcher(['sh', '-c', 'echo "bind: address already in use" >&2; exec sleep 5'], () => true, { ms: 300 }).catch((e: Error) => e)) as Error
    expect(e.message).toContain('never answered')
    expect(e.message).toContain('bind: address already in use')
  })
})
