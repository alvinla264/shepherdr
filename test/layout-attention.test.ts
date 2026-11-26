// What needs you across machines: Home's default actionable list, the requests and questions a chat keeps, and the
// one-line machine health, in a real browser (layout.ts). A chat never summarises them again as a strip of its own.
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

  test('a chat keeps no summary of its own, whatever the panel filters; machine health says the worst in words', async () => {
    const page = await browser!.newPage({ viewport: { width: 820, height: 1180 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=p:mac:~`)
    const panel = page.locator('section[aria-label="Tasks"]')
    await panel.getByText('LV-3', { exact: true }).waitFor()
    // the old attention strip and its dropdown are gone, not replaced
    expect(await page.locator('[data-attention]').count()).toBe(0)
    // nor does filtering the panel bring an aggregate back into the chat
    await panel.getByRole('searchbox', { name: 'Filter tasks' }).fill('LV-3')
    expect(await page.locator('[data-attention]').count()).toBe(0)
    expect(await page.getByText(/\d+ need you · \d+ ready/).count()).toBe(0)
    // health is one short status in the header; its details keep every reading
    await page.getByRole('button', { name: /^Machine health/ }).click()
    const health = page.getByRole('dialog', { name: 'mac health' })
    await health.waitFor()
    expect(await health.textContent()).toContain('Alert limit crossed')
    expect(await health.textContent()).toContain('18%')
    await page.keyboard.press('Escape')
    await settled(page)
    // a coordinator chat still shows its question card and each task update, and never a summary
    await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm`)
    await page.getByText('Rerun CI on main?', { exact: true }).waitFor()
    expect(await page.locator('[data-attention]').count()).toBe(0)
    expect(await page.getByText(/3 need you · 1 ready/).count()).toBe(0)
    await page.close()
  })
})
