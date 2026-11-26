// Ready and Needs you as one count circle, in the Tasks header and in each place's row, in a real browser (layout.ts).
import { describe, expect, test } from 'bun:test'
import { layout, until } from './layout.ts'

const { browser, world, url } = await layout()
const badge = '[data-attention-badge]'
const place = 'p:vm-str:gtm'

describe.skipIf(!browser)('one count circle', () => {
  test('it splits red and green when both wait, keeps the two counts apart, caps each at 9+ and goes when there is nothing', async () => {
    const saved = world.tasks
    const template = saved.find((t) => t.status === 'ready')!
    const requests = world.chats[place].messages
    const asks = world.asks
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    const tasks = (need: number, ready: number) =>
      Array.from({ length: need + ready }, (_, i) => ({ ...template, id: `CIRCLE-${i}`, place, status: i < need ? ('need' as const) : ('ready' as const), agent: undefined }))
    /** what each half of the panel's circle is coloured, as it is now */
    const halves = async () => {
      const found = page.locator(`section[aria-label="Tasks"] ${badge}`)
      await found.waitFor()
      return found.evaluate((el) => ({
        need: el.querySelector('.attention-badge-need') ? getComputedStyle(el.querySelector('.attention-badge-need')!).backgroundColor : null,
        ready: el.querySelector('.attention-badge-ready') ? getComputedStyle(el.querySelector('.attention-badge-ready')!).backgroundColor : null,
      }))
    }
    try {
      // the place's own tasks alone: no coordinator request of its chat, nothing of another space
      world.chats[place].messages = []
      world.asks = {}
      await page.goto(url().replace('vm-str/home', 'vm-str/gtm'))
      const panel = page.locator('section[aria-label="Tasks"]')
      const row = page.locator(`#places li[data-project="${place}"]`)
      for (const [need, ready] of [[0, 0], [1, 0], [0, 2], [2, 3], [12, 108]]) {
        world.tasks = [...tasks(need, ready), { ...template, id: 'CIRCLE-ARCHIVED', place, archived: Date.now() }, { ...template, id: 'CIRCLE-ELSEWHERE', place: 'p:mac:lilla-varlden' }]
        world.emit('snapshot')
        const found = panel.locator(badge)
        expect(await until(() => found.count(), (n) => n === (need || ready ? 1 : 0))).toBe(need || ready ? 1 : 0)
        if (!need && !ready) continue
        const label = `${need} needs you, ${ready} ready · panel scope`
        expect(await until(() => found.getAttribute('aria-label'), (s) => s === label)).toBe(label)
        expect(await found.getAttribute('data-attention-badge')).toBe(need && ready ? 'both' : need ? 'need' : 'ready')
        // each half carries its own count, in reading order: needs you, then ready
        expect(await found.locator(':scope > span').allTextContents()).toEqual([
          ...(need ? [need > 9 ? '9+' : String(need)] : []),
          ...(ready ? [ready > 9 ? '9+' : String(ready)] : []),
        ])
        // one circle, never a pill
        expect(await found.evaluate((el) => {
          const b = el.getBoundingClientRect()
          return b.width === b.height && getComputedStyle(el).borderRadius === '50%'
        })).toBe(true)
      }
      // each half keeps the colour it has on its own: red for needs you, green for ready
      world.tasks = tasks(1, 0)
      world.emit('snapshot')
      const red = (await until(halves, (h) => !!h.need)).need
      world.tasks = tasks(0, 1)
      world.emit('snapshot')
      const green = (await until(halves, (h) => !!h.ready)).ready
      expect(red).toBeTruthy()
      expect(green).toBeTruthy()
      expect(red).not.toBe(green)
      world.tasks = tasks(1, 1)
      world.emit('snapshot')
      const both = await until(halves, (h) => !!h.need && !!h.ready)
      expect(both).toEqual({ need: red, ready: green })
      // the place's own row shows the same two counts, for that space alone
      world.tasks = tasks(2, 3)
      world.emit('snapshot')
      expect(await until(() => row.locator(badge).getAttribute('aria-label'), (s) => s === '2 needs you, 3 ready · here')).toBe('2 needs you, 3 ready · here')
      expect(await row.locator(badge).count()).toBe(1)
      // and no extra "ready" words are left beside a circle
      expect(await panel.textContent()).not.toContain('ready tasks')
      expect(await row.textContent()).not.toContain('ready here')
    } finally {
      world.tasks = saved
      world.chats[place].messages = requests
      world.asks = asks
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)
})
