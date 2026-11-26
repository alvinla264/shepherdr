// Restarting an agent, in a real browser (layout.ts): the launch controls in a chat's + menu, the restart sheet from
// them or a ⋯ menu, and the card its chat shows after.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'

const { browser, world, server } = await layout({ everything: true })

describe.skipIf(!browser)('restarting an agent', () => {
  test('Settings that moved on show no banner any more: the launch controls wait in the + menu, and only Restart changes anything (phone and desktop)', async () => {
    const p = world.snapshot().places.find((x) => !x.home && world.chats[x.chat]?.restart)!
    for (const phone of [true, false]) {
      world.chats[p.chat].restart = { on: 'Claude Code', want: 'Codex' }
      world.chats[p.chat].cli = 'Claude Code'
      world.chats[p.chat].agent = { kind: 'claude', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high' }
      const before = JSON.stringify(world.chats[p.chat].agent)
      const width = phone ? 390 : 1280
      const page = await browser!.newPage(phone ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 800 } })
      await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}`)
      const controls = page.locator('[data-agent-controls]').last()
      // out of the composer's way until + opens, then one row each for Agent, Model and Effort
      await page.locator('[data-composer]').last().waitFor()
      expect(await controls.count()).toBe(0)
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').last().click()
      await controls.waitFor()
      expect(await page.locator('[data-restart-hint]').count()).toBe(0)
      expect(await controls.getByRole('menuitem').count()).toBe(3)
      expect(JSON.stringify(world.chats[p.chat].agent)).toBe(before)
      const box = (await controls.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      // a tap opens the sheet on what it runs on now, not on what Settings would start
      await controls.getByRole('menuitem', { name: /^Effort: / }).click()
      const sheet = page.getByRole('alertdialog', { name: 'Restart this space’s coordinator?' })
      await sheet.locator('[data-restart]').waitFor()
      expect(await sheet.textContent()).toContain('Recorded launch: Claude Code (Opus 5.5, high).')
      await sheet.getByRole('button', { name: 'Cancel' }).click()
      await page.close()
    }
  }, 30_000)

  test('a launch with no recorded model or effort says so inside +, and closing the menu changes nothing', async () => {
    const key = 'GTM-17/Agent'
    const was = world.chats[key].agent
    const wasCli = world.chats[key].cli
    world.chats[key].agent = { kind: 'codex' }
    world.chats[key].cli = 'Codex'
    const page = await browser!.newPage({ viewport: { width: 320, height: 844 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=all&task=GTM-17`)
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
      const controls = page.locator('[data-agent-controls]').last()
      await controls.getByRole('menuitem', { name: 'Model: Default / unknown. Select and restart', exact: true }).waitFor()
      expect(await controls.getByRole('menuitem', { name: 'Effort: Default / unknown. Select and restart', exact: true }).count()).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
      // closing + puts the composer back as it was
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
      await controls.waitFor({ state: 'detached' })
      expect(world.chats[key].agent).toEqual({ kind: 'codex' })
    } finally {
      world.chats[key].agent = was
      world.chats[key].cli = wasCli
      await page.close()
    }
  }, 30_000)

  test("a task's ⋯ opens the sheet: Settings' CLI picked, another CLI offers its models; Restart posts the card", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent('p:vm-str:gtm')}`)
    const row = page.locator('section[aria-label="Tasks"] li', { hasText: 'GTM-17' })
    await row.hover()
    await row.getByRole('button', { name: 'More for this task' }).click()
    await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17’s agent?' })
    await sheet.waitFor()
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.textContent()).toContain('It resumes its session.')
    expect(await sheet.textContent()).toContain('Its worktree and branch stay as they are.')
    await sheet.getByRole('button', { name: /^Agent: / }).click()
    await page.getByRole('menuitemradio', { name: 'Codex' }).click()
    expect(await sheet.textContent()).toContain('Codex takes over with the chat so far, the brief and the work on its branch.')
    await sheet.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('menuitemradio', { name: 'GPT-6-Sol', exact: true }).click()
    await sheet.getByRole('button', { name: /^Effort: / }).click()
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    await sheet.getByRole('button', { name: 'Restart', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats['GTM-17/Agent'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex (GPT-6-Sol, high)' })
    await page.close()
  }, 30_000)

  test('the sheet fits a phone, and Cancel leaves the agent as it was', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}`)
    await page.getByRole('button', { name: /^Menu/ }).click()
    await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
    const sheet = page.getByRole('alertdialog', { name: `Restart ${p.name}’s coordinator?` })
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.textContent()).toContain('Its tasks keep going.')
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    const cards = world.chats[p.chat].messages.filter((m) => m.card?.restart).length
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats[p.chat].messages.filter((m) => m.card?.restart).length).toBe(cards)
    await ctx.close()
  }, 30_000)

  test('a model its CLI no longer offers cannot be restarted on: the sheet says so and holds Restart until one of its own is picked (phone)', async () => {
    const key = 'GTM-17/Agent'
    const was = world.chats[key].agent
    world.chats[key].agent = { kind: 'claude', model: 'claude-gone-1', effort: 'high' }
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm&task=GTM-17`)
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
      await page.locator('[data-agent-controls]').last().getByRole('menuitem', { name: /^Model: / }).click()
      const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17’s agent?' })
      await sheet.locator('[data-restart]').waitFor()
      expect(await sheet.textContent()).toContain('claude-gone-1 is unavailable. Choose Default or an available model before restarting.')
      const restart = sheet.getByRole('button', { name: 'Restart', exact: true })
      expect(await restart.isDisabled()).toBe(true)
      // a model it does offer clears it
      await sheet.getByRole('button', { name: /^Model: / }).click()
      await page.getByRole('menuitemradio', { name: 'Opus 5.5', exact: true }).click()
      expect(await restart.isEnabled()).toBe(true)
      // the launch it was recorded on stays as it was: only Restart changes that
      expect(await sheet.textContent()).toContain('Recorded launch: Claude Code (claude-gone-1, high).')
      await sheet.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      world.chats[key].agent = was
      await page.close()
    }
  }, 30_000)
})
