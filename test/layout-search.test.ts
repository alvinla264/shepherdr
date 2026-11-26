// Search and jump: paging, scopes, exact destinations and chat search kept beside it, in a real browser (layout.ts).
import { describe, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import { layout, until } from './layout.ts'

const { browser, world, server, url } = await layout({ everything: true })

/** the global entrance: the phone's bottom bar, or the desktop's sidebar box */
async function openSearch(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 640) await page.getByRole('button', { name: 'Search', exact: true }).click()
  else await page.getByRole('button', { name: /^Search or jump to/ }).click()
  await page.getByRole('combobox', { name: 'Search or jump to' }).waitFor()
}

describe.skipIf(!browser)('unified search', () => {
  for (const width of [390, 1440]) test(`paging reaches the exact message (${width}px)`, async () => {
    const source = world.chats['LV-3/Agent']
    const was = source.messages
    source.messages = [...was, ...Array.from({ length: 25 }, (_, n) => ({ id: `ledger-${n}`, who: 'agent' as const, text: `Receipt ledger line ${n}`, at: Date.now() + n }))]
    const page = await browser!.newPage({ viewport: { width, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('textbox', { name: /^Message / }).first().waitFor()
      await openSearch(page)
      expect(await page.getByRole('button', { name: 'Everywhere', exact: true }).getAttribute('aria-pressed')).toBe('true')
      await page.getByRole('combobox', { name: 'Search or jump to' }).fill('receipt ledger')
      // the group shows the previous, unfiltered list (every message) while it says Filtering…: page only the
      // settled query's results, with every chat read
      const list = page.getByRole('listbox', { name: 'Search results' })
      expect(await until(() => list.getAttribute('aria-busy'), (v) => v === 'false')).toBe('false')
      const found = page.getByRole('group', { name: 'Messages', exact: true })
      await found.getByRole('option').first().waitFor()
      expect(await found.getByRole('option').count()).toBe(8)
      await found.getByRole('button', { name: /Show more messages/ }).click()
      // the page it adds arrives a moment after the click: wait for the count itself, not a sleep
      expect(await until(() => found.getByRole('option').count(), (n) => n === 25)).toBe(25)
      await found.getByRole('option', { name: /^Receipt ledger line 24 / }).click()
      expect(page.url()).toContain('task=LV-3')
      const target = page.locator('[data-msg="ledger-24"]')
      await target.waitFor()
      expect(await until(() => target.locator('[data-flash]').count(), (n) => n > 0)).toBeGreaterThan(0)
      expect(await page.getByRole('searchbox', { name: 'Search in this chat' }).inputValue()).toBe('receipt ledger')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally {
      source.messages = was
      await page.close()
    }
  }, 30_000)

  test("a chat keeps its own search, and starts the wider one in this chat's scope", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm&task=GTM-14`)
    await page.getByRole('textbox', { name: 'Message GTM-14…' }).waitFor()
    await page.getByRole('button', { name: 'More', exact: true }).click()
    expect(await page.getByRole('menuitem', { name: 'Search in this chat', exact: true }).count()).toBe(1)
    await page.getByRole('menuitem', { name: 'Search this chat and beyond' }).click()
    const search = page.getByRole('combobox', { name: 'Search or jump to' })
    await search.waitFor()
    expect(await page.getByRole('button', { name: 'This chat', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('button', { name: 'Space: gtm', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Machine: vm-str', exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Everywhere', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Everywhere', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.close()
  }, 30_000)

  test('a reply that arrives after its chat was read still reaches the open results', async () => {
    const key = world.snapshot().places[0].chat
    const chat = world.chats[key]
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('textbox', { name: /^Message / }).first().waitFor()
      await openSearch(page)
      await page.getByRole('combobox', { name: 'Search or jump to' }).fill('very-late-sentence')
      const list = page.getByRole('listbox', { name: 'Search results' })
      await list.waitFor()
      expect(await until(() => list.getAttribute('aria-busy'), (v) => v === 'false')).toBe('false')
      chat.messages.push({ id: 'very-late-hit', who: 'agent', text: 'A very-late-sentence arrives', at: Date.now() })
      world.emit('chat', key)
      await page.getByRole('option', { name: /^A very-late-sentence arrives/ }).waitFor()
      expect(await page.getByRole('option').count()).toBe(1)
    } finally {
      chat.messages = chat.messages.filter((m) => m.id !== 'very-late-hit')
      await page.close()
    }
  }, 30_000)

  test('a message found while its Tasks pane is focused opens the conversation there', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=vm-str/home`)
    await page.getByRole('textbox', { name: 'Message home…' }).waitFor()
    const gtm = page.locator('#places li[data-project="p:vm-str:gtm"]')
    await gtm.hover()
    await gtm.getByRole('button', { name: 'More for gtm' }).click()
    await page.getByRole('menuitem', { name: 'Open its tasks in split view' }).click()
    const tasks = page.getByRole('region', { name: 'Tasks of gtm', exact: true })
    await tasks.waitFor()
    // give the Tasks pane the keys, as a click in it would
    await tasks.evaluate((n) => { (n as HTMLElement).tabIndex = -1; (n as HTMLElement).focus() })
    await openSearch(page)
    await page.getByRole('combobox', { name: 'Search or jump to' }).fill('Rerun CI on main')
    const messages = page.getByRole('group', { name: 'Messages', exact: true })
    await messages.getByRole('option').first().waitFor()
    await messages.getByRole('option').first().click()
    // the focused pane now shows gtm's conversation, with the found message in it
    await page.locator('[data-pane="1"] [data-messages]').getByText(/Rerun CI on main/).first().waitFor()
    expect(await page.getByRole('region', { name: 'Tasks of gtm', exact: true }).count()).toBe(0)
    await page.close()
  }, 30_000)

  test('an artifact opens at the place it belongs to', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(url())
    await page.getByRole('textbox', { name: /^Message / }).first().waitFor()
    await openSearch(page)
    await page.getByRole('combobox', { name: 'Search or jump to' }).fill('draft')
    const artifacts = page.getByRole('group', { name: 'Artifacts', exact: true })
    await artifacts.getByRole('option').first().waitFor()
    await artifacts.getByRole('option').first().click()
    expect(page.url()).toContain('artifact=')
    expect(page.url()).toContain('mac%2Flilla-varlden')
    await page.close()
  }, 30_000)
})
