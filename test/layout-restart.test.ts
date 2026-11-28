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
      const sheet = page.getByRole('alertdialog', { name: 'Restart coordinator?' })
      await sheet.locator('[data-restart]').waitFor()
      // what it runs on now is the three picks, without the paragraphs that repeated it
      expect(await sheet.getByRole('button', { name: /^Agent: / }).count()).toBe(1)
      expect(await sheet.getByRole('button', { name: /^Model: / }).count()).toBe(1)
      expect(await sheet.textContent()).not.toContain('Recorded launch')
      expect(await sheet.textContent()).not.toContain('Applies to this chat')
      await sheet.getByRole('button', { name: 'Cancel' }).click()
      await page.close()
    }
  }, 30_000)

  test('a launch with nothing the CLI reports says so inside +, and closing the menu changes nothing', async () => {
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
      await controls.getByRole('menuitem', { name: 'Model: Not reported. Select and restart', exact: true }).waitFor()
      expect(await controls.getByRole('menuitem', { name: 'Effort: Not reported. Select and restart', exact: true }).count()).toBe(1)
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
    const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17 agent?' })
    await sheet.waitFor()
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(1)
    expect(await sheet.getByRole('button', { name: 'Restart', exact: true }).count()).toBe(1)
    // opened on what Settings would start, nothing is saved: the switch waits for a pick that differs
    expect(await sheet.getByRole('switch').count()).toBe(0)
    await sheet.getByRole('button', { name: /^Agent: / }).click()
    await page.getByRole('menuitemradio', { name: 'Codex' }).click()
    expect(await sheet.textContent()).toContain('Codex starts a new session with this chat, the brief and branch.')
    expect(await sheet.getByRole('switch', { name: 'Use for future task agents in gtm' }).isChecked()).toBe(false)
    await sheet.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('menuitemradio', { name: 'GPT-6-Sol', exact: true }).click()
    await sheet.getByRole('button', { name: /^Effort: / }).click()
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    await sheet.getByRole('button', { name: 'Restart', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats['GTM-17/Agent'].messages.at(-1)?.card).toMatchObject({ restart: true, text: 'Restarted on Codex (GPT-6-Sol, high)' })
    await page.close()
  }, 30_000)

  test('the + menu names what the CLI reports, in a task chat and a coordinator chat, and never changes the launch', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    for (const task of [false, true]) {
      const chat = task ? 'GTM-17/Agent' : p.chat
      const was = world.chats[chat].agent
      const wasCli = world.chats[chat].cli
      // the launch stays what it was started with; what the CLI reports now is what the menu shows
      world.chats[chat].agent = { kind: 'codex', model: 'gpt-6-sol', modelLabel: 'GPT-6-Sol', effort: 'low', runtime: { model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1-Sol', effort: 'high', source: 'session', at: Date.now() } }
      world.chats[chat].cli = 'Codex'
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
      try {
        await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}${task ? '&task=GTM-17' : ''}`)
        // a docked task brings its own composer: the first is the chat on screen
        await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
        const controls = page.locator('[data-agent-controls]').last()
        await controls.getByRole('menuitem', { name: 'Model: GPT-6.1-Sol. Select and restart', exact: true }).waitFor()
        expect(await controls.getByRole('menuitem', { name: 'Effort: High. Select and restart', exact: true }).count()).toBe(1)
        expect(world.chats[chat].agent).toMatchObject({ model: 'gpt-6-sol', effort: 'low' })
        // Default is still a model to pick in the sheet
        await controls.getByRole('menuitem', { name: /^Model: / }).click()
        const sheet = page.getByRole('alertdialog')
        await sheet.locator('[data-restart]').waitFor()
        await sheet.getByRole('button', { name: /^Model: / }).click()
        expect(await page.getByRole('menuitemradio', { name: 'Default', exact: true }).count()).toBe(1)
        await page.getByRole('menuitemradio', { name: 'Default', exact: true }).click()
        expect(await sheet.getByRole('button', { name: /^Model: / }).textContent()).toContain('Default')
        await sheet.getByRole('button', { name: 'Cancel' }).click()
      } finally {
        world.chats[chat].agent = was
        world.chats[chat].cli = wasCli
        await page.close()
      }
    }
  }, 30_000)

  test('an effort its CLI reports as unsupported says Not supported, not a level it might be on', async () => {
    const key = 'GTM-17/Agent'
    const was = world.chats[key].agent
    world.chats[key].agent = { kind: 'codex', runtime: { model: 'gpt-6-sol', effortUnsupported: true, source: 'session', at: Date.now() } }
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm&task=GTM-17`)
      await page.locator('[data-composer] button[aria-label="Attach files and more"]').first().click()
      const controls = page.locator('[data-agent-controls]').last()
      await controls.getByRole('menuitem', { name: 'Effort: Not supported. Select and restart', exact: true }).waitFor()
      expect(await controls.getByRole('menuitem', { name: 'Model: gpt-6-sol. Select and restart', exact: true }).count()).toBe(1)
    } finally {
      world.chats[key].agent = was
      await page.close()
    }
  }, 30_000)

  test('the sheet fits a phone, and Cancel leaves the agent as it was', async () => {
    const p = world.snapshot().places.find((x) => !x.home)!
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${server!.port}/?place=${encodeURIComponent(p.id)}`)
    await page.getByRole('button', { name: /^Menu/ }).click()
    await page.getByRole('menuitem', { name: 'Restart agent…' }).click()
    const sheet = page.getByRole('alertdialog', { name: 'Restart coordinator?' })
    await sheet.locator('[data-restart]').waitFor()
    expect(await sheet.getByRole('button', { name: 'Restart', exact: true }).count()).toBe(1)
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    const cards = world.chats[p.chat].messages.filter((m) => m.card?.restart).length
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(world.chats[p.chat].messages.filter((m) => m.card?.restart).length).toBe(cards)
    await ctx.close()
  }, 30_000)

  test('the handoff note and the package another CLI was handed show as cards, fitting a phone', async () => {
    const key = 'GTM-17/Agent'
    const before = world.chats[key].messages
    const at = Date.now()
    world.chats[key].messages = [
      ...before,
      { id: 'handoff-note:GTM-17', who: 'agent', at, card: { id: 'handoff-note:GTM-17', note: { text: 'hello.txt added; next the tests', by: 'Claude Code' }, text: 'Handoff note' } },
      {
        id: 'handoff:GTM-17:1',
        who: 'agent',
        at: at + 1,
        card: { id: 'handoff:GTM-17:1', handoff: { to: 'Codex', text: 'The brief as given:\n\nAdd hello.txt\n\nThe human said:\n\nUse blue' }, text: 'Handoff to Codex' },
      },
    ]
    const page = await browser!.newPage({ viewport: { width: 320, height: 844 } })
    try {
      await page.goto(`http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm&task=GTM-17`)
      const note = page.locator('[data-handoff-note]').last()
      await note.waitFor()
      expect(await note.textContent()).toContain('hello.txt added; next the tests')
      const card = page.locator('[data-handoff-card]').last()
      await card.waitFor()
      expect(await card.textContent()).toContain('Handoff to Codex')
      expect(await card.textContent()).toContain('Use blue')
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    } finally {
      world.chats[key].messages = before
      await page.close()
    }
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
      const sheet = page.getByRole('alertdialog', { name: 'Restart GTM-17 agent?' })
      await sheet.locator('[data-restart]').waitFor()
      expect(await sheet.textContent()).toContain('claude-gone-1 is unavailable. Choose Default or an available model before restarting.')
      const restart = sheet.getByRole('button', { name: 'Restart', exact: true })
      expect(await restart.isDisabled()).toBe(true)
      // a model it does offer clears it
      await sheet.getByRole('button', { name: /^Model: / }).click()
      await page.getByRole('menuitemradio', { name: 'Opus 5.5', exact: true }).click()
      expect(await restart.isEnabled()).toBe(true)
      // the launch it was recorded on stays as it was: only Restart changes that
      expect(world.chats[key].agent).toEqual({ kind: 'claude', model: 'claude-gone-1', effort: 'high' })
      await sheet.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      world.chats[key].agent = was
      await page.close()
    }
  }, 30_000)
})
