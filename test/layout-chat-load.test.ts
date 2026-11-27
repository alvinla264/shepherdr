// A chat with hundreds of messages in it, in a real browser (layout.ts): only the messages near what shows are drawn,
// with a spacer standing in for the rest (window.tsx), so the DOM stops growing with how long an agent has run. It
// still opens at its newest message, scrolls to the oldest at the top, lands on a message jumped to from far outside
// what is drawn, and every reply taller than the screen still folds (measured by its own observer, fold.tsx, and
// folded at once when the window draws it again). Each message's time comes from one formatter for them all.
import { describe, expect, test } from 'bun:test'
import type { Message } from '../shared/types.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

/** a reply far taller than a phone's screen: it must fold */
const tall = (id: string, at: number, word = 'Line'): Message => ({
  id,
  who: 'agent',
  at,
  text: Array.from({ length: 40 }, (_, i) => `${word} ${i + 1} of a reply far taller than the screen.`).join('\n\n'),
})

/** the chat's scroller: how far it is from its bottom, and where it is */
const scroll = (page: import('playwright-core').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-messages]')!.closest('.overflow-y-auto') as HTMLElement
    return { left: el.scrollHeight - el.scrollTop - el.clientHeight, top: el.scrollTop }
  })

/** how many of the chat's messages are drawn */
const drawn = (page: import('playwright-core').Page) => page.locator('[data-messages] [data-msg]').count()

describe.skipIf(!browser)('a chat with hundreds of messages', () => {
  test('draws only what is near what shows, follows the scroll to either end, and jumps to a message far down it (phone)', async () => {
    const key = 'p:vm-str:~'
    // the same minute twice, then another: what a time must say, without depending on this machine's clock settings
    const base = Date.UTC(2026, 4, 1, 12, 23)
    const many: Message[] = Array.from({ length: 400 }, (_, i): Message => ({
      id: `long-${i}`,
      who: i % 2 ? 'agent' : 'you',
      at: base + i * 60_000,
      text: i % 2 ? `A reply with **bold** and \`code\`, number ${i}.` : `Question number ${i}`,
    }))
    // the oldest is far taller than the screen, and the second newest answers it: a tap on that quote jumps back to it
    many[0] = tall('long-0', base)
    many[399] = { id: 'long-399', who: 'agent', at: base + 399 * 60_000, text: 'Here it is, from the top.', reply: { id: 'long-0', who: 'agent', text: 'Tall line 1 of a reply far taller than the screen.' } }
    many.push(
      { id: 'minute-a', who: 'you', at: base + 400 * 60_000, text: 'The same minute.' },
      { id: 'minute-b', who: 'agent', at: base + 400 * 60_000 + 20_000, text: 'Twenty seconds later.' },
      { id: 'minute-c', who: 'agent', at: base + 402 * 60_000, text: 'Two minutes later.' },
    )
    world.chats[key].messages = many

    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.goto(url())
    // it opens at its newest message, as before, whatever the chat's size
    await page.locator('[data-msg="minute-c"]').waitFor({ timeout: 30_000 })
    expect((await scroll(page)).left).toBeLessThan(2)
    // only the messages near it are drawn, out of 403: the oldest is not in the DOM at all
    const near = await drawn(page)
    expect(near).toBeGreaterThan(20)
    expect(near).toBeLessThan(200)
    expect(await page.locator('[data-msg="long-0"]').count()).toBe(0)

    // each message says its own time, as this browser would say it: the same for two in one minute, another for the next
    const time = (id: string) => page.locator(`[data-arrive]:has([data-msg="${id}"]) time`).textContent()
    const [a, b, c] = [await time('minute-a'), await time('minute-b'), await time('minute-c')]
    expect(a).toBe(await page.evaluate((at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), base + 400 * 60_000))
    expect(b).toBe(a)
    expect(c).not.toBe(a)

    // read to the top: the oldest is drawn there, and what was at the bottom is gone again
    await page.evaluate(() => ((document.querySelector('[data-messages]')!.closest('.overflow-y-auto') as HTMLElement).scrollTop = 0))
    await page.locator('[data-msg="long-0"]').waitFor({ timeout: 10_000 })
    expect((await scroll(page)).top).toBeLessThan(2)
    expect(await drawn(page)).toBeLessThan(200)
    expect(await page.locator('[data-msg="minute-c"]').count()).toBe(0)

    // a reply taller than the screen still folds, and opens: measured as it comes into the window
    const first = page.locator('[data-msg="long-0"]')
    await first.getByRole('button', { name: 'Show more' }).waitFor({ timeout: 10_000 })
    expect((await first.locator('[data-anchor]').boundingBox())!.height).toBeLessThan(420)
    await first.getByRole('button', { name: 'Show more' }).evaluate((b) => (b as HTMLElement).click())
    await first.getByRole('button', { name: 'Show less' }).waitFor()
    expect((await first.locator('[data-anchor]').boundingBox())!.height).toBeGreaterThan(900)

    // the arrow back to the newest message lands on it, as it did when every message was drawn
    await page.getByRole('button', { name: /jump to the latest/i }).click()
    await page.locator('[data-msg="minute-c"]').waitFor({ timeout: 10_000 })
    expect((await scroll(page)).left).toBeLessThan(2)

    // a jump to a message far outside what is drawn draws it and lands on it, lit up for a moment
    await page.locator('[data-msg="long-399"] [data-quote]').evaluate((q) => (q as HTMLElement).click())
    const old = page.locator('[data-msg="long-0"] [data-anchor][data-flash]')
    await old.waitFor({ timeout: 10_000 })
    const [seen, view] = await Promise.all([old.boundingBox(), page.locator('[data-messages]').boundingBox()])
    expect(seen!.y).toBeLessThan(view!.y + view!.height)
    expect(seen!.y + seen!.height).toBeGreaterThan(view!.y)
    await page.close()
  }, 60_000)
})
