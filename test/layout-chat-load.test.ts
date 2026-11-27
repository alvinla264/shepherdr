// A chat with hundreds of messages in it, in a real browser (layout.ts): every reply taller than the screen still
// folds to Show more and opens, though each one is measured by its own observer as it comes in rather than read for
// its height on the way into the DOM (fold.tsx), and each message's time comes from one formatter for them all.
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

describe.skipIf(!browser)('a chat with many messages', () => {
  test('folds every tall reply and opens it, and says each time (phone)', async () => {
    const key = 'p:vm-str:~'
    // the same minute twice, then another: what a time must say, without depending on this machine's clock settings
    const base = Date.UTC(2026, 4, 1, 12, 23)
    const many: Message[] = [
      { id: 'minute-a', who: 'you', at: base, text: 'The same minute.' },
      { id: 'minute-b', who: 'agent', at: base + 20_000, text: 'Twenty seconds later.' },
      { id: 'minute-c', who: 'agent', at: base + 120_000, text: 'Two minutes later.' },
    ]
    for (let i = 0; i < 150; i++) {
      many.push({ id: `ask-${i}`, who: 'you', at: base + 600_000 + i * 2000, text: `Pass ${i}, please.` })
      many.push(
        i % 50 === 0
          ? tall(`reply-${i}`, base + 600_000 + i * 2000 + 1, `Tall line ${i}`)
          : { id: `reply-${i}`, who: 'agent', at: base + 600_000 + i * 2000 + 1, text: `Done with pass ${i}.` },
      )
    }
    world.chats[key].messages = many

    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.goto(url())
    await page.locator('[data-msg="reply-149"]').waitFor({ timeout: 30_000 })
    // a reply is measured after it is in the DOM, so wait for the folds rather than for the rows: all three, and no more
    await page.waitForFunction(() => document.querySelectorAll('[data-folded]').length === 3, null, { timeout: 30_000 })

    // every tall reply is folded, and no short one grew the button
    expect(await page.getByRole('button', { name: 'Show more' }).count()).toBe(3)
    for (const i of [0, 50, 100]) expect((await page.locator(`[data-msg="reply-${i}"] [data-anchor]`).boundingBox())!.height).toBeLessThan(420)
    expect(await page.locator('[data-msg="reply-149"]').getByRole('button', { name: /Show more|Show less/ }).count()).toBe(0)

    // one opens, and closes again
    const first = page.locator('[data-msg="reply-0"]')
    await first.getByRole('button', { name: 'Show more' }).evaluate((b) => (b as HTMLElement).click())
    await first.getByRole('button', { name: 'Show less' }).waitFor()
    expect((await first.locator('[data-anchor]').boundingBox())!.height).toBeGreaterThan(900)
    await first.getByRole('button', { name: 'Show less' }).evaluate((b) => (b as HTMLElement).click())
    await first.getByRole('button', { name: 'Show more' }).waitFor()
    expect((await first.locator('[data-anchor]').boundingBox())!.height).toBeLessThan(420)

    // each message says its own time, as this browser would say it: the same for two in one minute, another for the next
    const time = (id: string) => page.locator(`[data-arrive]:has([data-msg="${id}"]) time`).textContent()
    const [a, b, c] = [await time('minute-a'), await time('minute-b'), await time('minute-c')]
    expect(a).toBe(await page.evaluate((at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), base))
    expect(b).toBe(a)
    expect(c).not.toBe(a)
    await page.close()
  })
})
