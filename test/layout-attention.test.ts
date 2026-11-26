// What needs you across machines: Home's default actionable list, its summary in a coordinator chat, and the one-line
// machine health, in a real browser (layout.ts).
import { describe, expect, test } from 'bun:test'
import { layout, settled } from './layout.ts'

const { browser, server } = await layout()

const ids = (rows: import('playwright-core').Locator) => rows.evaluateAll((li) => li.map((l) => l.textContent?.match(/[A-Z]+-\d+/)?.[0]))

describe.skipIf(!browser)('Home attention', () => {
  test('a fresh Home shows actionable work across machines; search, Show all tasks and a locked scope each win', async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => localStorage.removeItem('shepherdr.lists'))
    await page.goto(`http://127.0.0.1:${server!.port}/?place=vm-str/home`)
    const panel = page.locator('section[aria-label="Tasks"]')
    await panel.getByText('Actionable · all machines', { exact: true }).waitFor()
    expect(await ids(panel.locator('li'))).toContain('LV-3')
    expect(await ids(panel.locator('li'))).not.toContain('HP-202')
    // typing a search shows everything it matches, not only what needs you
    const search = panel.getByRole('searchbox', { name: 'Filter tasks' })
    await search.fill('HP-202')
    await panel.getByText('HP-202', { exact: true }).waitFor()
    await search.fill('')
    // Show all tasks leaves the default behind for this device
    await panel.getByRole('button', { name: 'Show all tasks', exact: true }).click()
    await panel.getByText('HP-202', { exact: true }).waitFor()
    // a locked filter scope survives switching space
    await page.getByRole('button', { name: 'Lock filters: keep them when switching spaces', exact: true }).click()
    await page.getByRole('button', { name: /^lilla-varlden,/ }).click()
    await panel.getByText('HP-202', { exact: true }).waitFor()
    expect(await panel.getByText('Everything', { exact: true }).count()).toBe(1)
    await page.close()
  })

  test('a filtered panel leaves a chat summary of original requests, and machine health says the worst in words', async () => {
    const page = await browser!.newPage({ viewport: { width: 820, height: 1180 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=p:mac:~`)
    const panel = page.locator('section[aria-label="Tasks"]')
    await panel.getByText('LV-3', { exact: true }).waitFor()
    // the panel already shows everything the chat would summarise: no repeated summary
    expect(await page.locator('[data-attention]').count()).toBe(0)
    // a filter hides one request from the panel, so the summary names it
    await panel.getByRole('searchbox', { name: 'Filter tasks' }).fill('LV-3')
    await page.locator('[data-attention] summary').click()
    expect(await page.locator('[data-attention]').textContent()).toContain('LV-4')
    // health is one short status in the header; its details keep every reading
    await page.getByRole('button', { name: /^Machine health/ }).click()
    const health = page.getByRole('dialog', { name: 'mac health' })
    await health.waitFor()
    expect(await health.textContent()).toContain('Alert limit crossed')
    expect(await health.textContent()).toContain('18%')
    await page.keyboard.press('Escape')
    await settled(page)
    // a coordinator chat counts its own tasks and question once, and Ready apart
    await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm`)
    await page.getByText('Rerun CI on main?', { exact: true }).waitFor()
    expect(await page.locator('[data-attention] summary').textContent()).toContain('3 need you · 1 ready')
    await page.close()
  })
})
