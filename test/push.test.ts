// Push alerts that reach a phone: this server signs them with VAPID keys that stay put and a signing contact a push
// service accepts, and keeps a quiet note per device of what failed, never the private details behind it.
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createECDH, randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { Settings } from '../server/live/settings.ts'
import { DEFAULT_PUSH_CONTACT, Push, pushContact } from '../server/push.ts'
import { readJson, writeJson } from '../server/store.ts'
import type { Alert } from '../shared/types.ts'

const alert: Alert = { id: 'n1', from: 'Shepherdr', title: 'SHE-1 needs you', body: 'Approve the plan', go: { place: 'all' } }
const accepted = { statusCode: 201, body: '', headers: {} }
const phone = { endpoint: 'https://push.apple.example/phone', keys: { auth: 'auth-of-phone', p256dh: 'key-of-phone' } }
const mac = { endpoint: 'https://push.mozilla.example/mac', keys: { auth: 'auth-of-mac', p256dh: 'key-of-mac' } }
const label = () => 'a device'
const alertsRow = (push: Push) =>
  new Settings().sections(push.devices, [], null, undefined, [], undefined, undefined, push.warnings(label)).flatMap((s) => s.rows).find((r) => r.key === 'alerts')

/** a push service we steer by the device at the end of each endpoint: a status, or an error of its own */
type Answer = number | Error
function service(answers: Record<string, Answer> = {}) {
  const calls: { to: string; subject?: string }[] = []
  const deliver: typeof webpush.sendNotification = async (s, _body, opts) => {
    const to = s.endpoint.split('/').pop()!
    calls.push({ to, subject: opts?.vapidDetails?.subject })
    const answer = answers[to] ?? 201
    if (answer instanceof Error) throw answer
    if (answer >= 200 && answer < 300) return { statusCode: answer, body: '', headers: {} }
    throw { statusCode: answer }
  }
  return { calls, deliver }
}

beforeEach(() => writeJson('push.json', []))

describe('the signing contact', () => {
  test('a public https or mailto address is kept; a local or malformed one falls back to the project', () => {
    for (const bad of ['mailto:shepherdr@localhost', 'https://localhost', 'https://127.0.0.1', 'https://a.localhost', 'http://example.com', 'garbage', undefined])
      expect(pushContact(bad)).toBe(DEFAULT_PUSH_CONTACT)
    expect(pushContact('mailto:ops@example.com')).toBe('mailto:ops@example.com')
    expect(pushContact('https://example.com/push')).toBe('https://example.com/push')
  })

  test('the keys stay put across restarts, and each server signs with its own contact', async () => {
    const first = service()
    const before = new Push('mailto:shepherdr@localhost', first.deliver)
    before.subscribe(phone, 'a phone')
    const keys = readJson<unknown>('vapid.json', null)
    const second = service()
    const after = new Push('mailto:ops@example.com', second.deliver)
    expect(after.publicKey).toBe(before.publicKey)
    expect(readJson<unknown>('vapid.json', null)).toEqual(keys)
    await before.send(alert)
    await after.send(alert)
    expect([first.calls[0]!.subject, second.calls[0]!.subject]).toEqual([DEFAULT_PUSH_CONTACT, 'mailto:ops@example.com'])
  })

  test('the token a push service reads names that contact', async () => {
    const device = createECDH('prime256v1')
    device.generateKeys()
    let subject = ''
    const push = new Push(undefined, async (subscription, payload, options) => {
      const request = webpush.generateRequestDetails(subscription, payload ?? undefined, options)
      const jwt = /t=([^,]+)/.exec(String(request.headers.Authorization))![1]!
      subject = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).sub
      return accepted
    })
    push.subscribe({ endpoint: 'https://web.push.apple.com/fake', keys: { p256dh: device.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, 'a phone')
    await push.send(alert)
    expect(subject).toBe(DEFAULT_PUSH_CONTACT)
    expect(push.warnings(label)).toEqual([])
  })
})

describe('a device that could not be reached', () => {
  test('is named by its place, without its endpoint, keys or the provider’s own words; once, until it works', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const answers: Record<string, Answer> = { phone: 403 }
      const push = new Push(undefined, service(answers).deliver)
      push.subscribe(phone, 'the iPhone')
      push.subscribe(mac, 'the Mac')
      await push.send(alert)
      expect(push.warnings(label)).toEqual(['Device 1 (a device): Push service rejected the alert (HTTP 403).'])
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/push\.apple|auth-of-phone|key-of-phone/)
      // the same failure again is not logged twice
      await push.send(alert)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(alertsRow(push)?.warn).toContain('1 device could not receive the last alert.')
      // a device whose app is showing gets no alert, so its note stays
      answers.phone = 201
      await push.send(alert, new Set([phone.endpoint]))
      expect(push.warnings(label)).toHaveLength(1)
      // the next alert it accepts clears it
      await push.send(alert)
      expect(push.warnings(label)).toEqual([])
      expect(alertsRow(push)?.warn).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  test('an expired device is dropped; one that failed is kept until it works or subscribes again', async () => {
    const push = new Push(undefined, service({ phone: 404, mac: 410, tablet: 503 }).deliver)
    push.subscribe(phone, 'a phone')
    push.subscribe(mac, 'a mac')
    push.subscribe({ endpoint: 'https://push.mozilla.example/tablet', keys: { auth: 'a', p256dh: 'k' } }, 'a tablet')
    await push.send(alert)
    expect(push.devices).toEqual(['a tablet'])
    expect(readJson<unknown[]>('push.json', [])).toHaveLength(1)
    expect(push.warnings(label)).toHaveLength(1)
    push.subscribe({ endpoint: 'https://push.mozilla.example/tablet', keys: { auth: 'a', p256dh: 'k' } }, 'a tablet')
    expect(push.warnings(label)).toEqual([])
  })

  test('a slow failure cannot delete a device that subscribed again since, nor overwrite a newer success', async () => {
    let reject!: (e: unknown) => void
    let slow = true
    const push = new Push(undefined, async () => {
      if (slow) {
        slow = false
        return new Promise((_resolve, no) => (reject = no))
      }
      return accepted
    })
    push.subscribe(phone, 'a phone')
    const pending = push.send(alert)
    await push.send(alert)
    reject({ statusCode: 403 })
    await pending
    expect(push.warnings(label)).toEqual([])
    slow = true
    const expiring = push.send(alert)
    push.subscribe(phone, 'a new phone')
    reject({ statusCode: 410 })
    await expiring
    expect(push.devices).toEqual(['a new phone'])
  })

  test('a slow expiry cannot delete a device a newer alert already reached', async () => {
    let release!: (e: unknown) => void
    let slow = true
    const push = new Push(undefined, async () => {
      if (slow) {
        slow = false
        return new Promise((_resolve, no) => (release = no))
      }
      return accepted
    })
    push.subscribe(phone, 'a phone')
    const stale = push.send(alert)
    await push.send(alert)
    release({ statusCode: 410 })
    await stale
    expect(push.devices).toEqual(['a phone'])
  })

  test('two devices fail apart: the one that recovers stops being named, the other stays', async () => {
    const answers: Record<string, Answer> = { phone: new Error('the provider said: token https://push.apple.example/phone is dead'), mac: new Error('timed out') }
    const push = new Push(undefined, service(answers).deliver)
    push.subscribe(phone, 'a phone')
    push.subscribe(mac, 'a mac')
    await push.send(alert)
    expect(push.warnings(label)).toEqual(['Device 1 (a device): Could not reach the push service.', 'Device 2 (a device): Could not reach the push service.'])
    answers.mac = 201
    await push.send(alert)
    expect(push.warnings(label)).toEqual(['Device 1 (a device): Could not reach the push service.'])
  })
})
