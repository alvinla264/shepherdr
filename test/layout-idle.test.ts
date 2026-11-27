// An idle screen, in a real browser (layout.ts): the server's poll sends the snapshot it already shows, and no part of
// the screen is told to draw again; a hidden tab has its chats read by nothing, and waking it catches up in one go. The kernel
// counts how often it tells the screen's parts something changed (kernel.ts), so the check is the work done, not just
// what the DOM happens to show.
import { describe, expect, test } from 'bun:test'
import { layout, until } from './layout.ts'

const { browser, world, url } = await layout()

/** how many times the screen's parts were told to draw so far */
const told = (page: import('playwright-core').Page) => page.evaluate(() => (window as unknown as { __shepherdrTells?: number }).__shepherdrTells ?? 0)

/** the count it has settled on: nothing pending (a read marked, a picture loading) is still telling it to draw */
async function quiet(page: import('playwright-core').Page) {
  let was = await told(page)
  for (;;) {
    await page.waitForTimeout(250)
    const now = await told(page)
    if (now === was) return now
    was = now
  }
}

const key = 'p:vm-str:~'

describe.skipIf(!browser)('an idle screen', () => {
  test('draws nothing again for the snapshots the server repeats, and still draws what changes', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.goto(url())
    await page.locator('[data-msg="short-agent"]').waitFor({ timeout: 30_000 })
    await page.waitForFunction(() => typeof (window as unknown as { __shepherdrTells?: number }).__shepherdrTells === 'number')
    const before = await quiet(page)
    // what the 30 second poll sends: the same snapshot, again and again
    for (let i = 0; i < 10; i++) {
      world!.emit('snapshot')
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(300)
    expect(await told(page)).toBe(before)
    // a real change still arrives: a message in the open chat
    world!.chats[key].messages.push({ id: 'idle-new', who: 'agent', at: Date.now(), text: 'Something new.' })
    world!.emit('chat', key)
    await page.locator('[data-msg="idle-new"]').waitFor({ timeout: 5000 })
    expect(await told(page)).toBeGreaterThan(before)
    await page.close()
  }, 30_000)

  test('follows no chat while hidden, and waking it catches up in one go', async () => {
    const watched: string[][] = []
    const watch = world!.watch.bind(world)
    world!.watch = (chats: string[], terms: string[]) => {
      watched.push(chats)
      watch(chats, terms)
    }
    const last = () => watched.at(-1) ?? []
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.goto(url())
    await page.locator('[data-msg="short-agent"]').waitFor({ timeout: 30_000 })
    // what it shows, the server is reading for it
    expect(await until(() => Promise.resolve(last()), (c) => c.includes(key))).toContain(key)
    // hidden: no chat is followed any more, so no log is read for a screen nobody sees
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await until(() => Promise.resolve(last()), (c) => c.length === 0)).toEqual([])
    // what came while nothing read its chat: the server did not send it, as it has no reason to have read it either
    world!.chats[key].messages.push({ id: 'idle-hidden', who: 'agent', at: Date.now(), text: 'While you were away.' })
    await page.waitForTimeout(300)
    expect(await page.locator('[data-msg="idle-hidden"]').count()).toBe(0)
    // shown again: it follows its chat again, and what it missed comes at once
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.locator('[data-msg="idle-hidden"]').waitFor({ timeout: 5000 })
    expect(await until(() => Promise.resolve(last()), (c) => c.includes(key))).toContain(key)
    await page.close()
  }, 30_000)
})
