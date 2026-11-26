// Settings: the scope it edits, Notifications and Voice, a value set here and its Reset, in a real browser (layout.ts).
import { describe, expect, test } from 'bun:test'
import { settings as demoSettings } from '../server/demo/data.ts'
import { layout } from './layout.ts'

const { browser, world, url } = await layout()

describe.skipIf(!browser)('settings', () => {
  test('a value set here says so and what it inherits; Reset puts it back and leaves every other level alone (phone)', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const value = (level: string) => world.sections.find((s) => s.level === level && s.name === 'Notify')!.rows[0].value
    const everywhere = () => ['all', 'm:vm-str', 'p:mac:~'].map(value)
    const was = everywhere()
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      const list = settings.getByRole('navigation', { name: 'Sections' })
      // delivery rules for this space, and the devices enrolled Everywhere, on one page
      await list.getByRole('button', { name: 'Notifications', exact: true }).click()
      const notify = settings.getByRole('region', { name: 'Notifications' })
      await notify.waitFor()
      const rule = notify.getByRole('group', { name: 'Notify' })
      expect(await rule.getByRole('button', { name: 'Needs me' }).getAttribute('aria-pressed')).toBe('true')
      await notify.getByRole('button', { name: 'Add this device', exact: true }).waitFor()
      await rule.getByRole('button', { name: 'Off', exact: true }).click()
      await notify.getByRole('button', { name: 'Reset to Needs me', exact: true }).waitFor()
      expect(value('p:vm-str:~')).toBe('Off')
      expect(everywhere()).toEqual(was)
      // highlighted, with the value it inherits and where that comes from
      expect(await notify.textContent()).toContain('Set here')
      expect(await notify.textContent()).toContain('Inherits Needs me · Everywhere')
      // Reset: the row is unset here, and nothing else moved
      await notify.getByRole('button', { name: 'Reset to Needs me', exact: true }).click()
      await notify.getByRole('button', { name: 'Reset to Needs me', exact: true }).waitFor({ state: 'detached' })
      expect(value('p:vm-str:~')).toBe('Needs me')
      expect(everywhere()).toEqual(was)
      // Voice is its own page, one for all: its row, and no device to enrol
      await notify.getByRole('button', { name: 'Back', exact: true }).click()
      await notify.waitFor({ state: 'detached' })
      await list.getByRole('button', { name: 'Voice', exact: true }).click()
      const voice = settings.getByRole('region', { name: 'Voice' })
      await voice.waitFor()
      expect(await voice.textContent()).toContain('ElevenLabs')
      expect(await voice.getByRole('button', { name: 'Add this device', exact: true }).count()).toBe(0)
      // the exact line a setting adds to a brief is there when asked for, not before
      await voice.getByRole('button', { name: 'Back', exact: true }).click()
      await list.getByRole('button', { name: 'How tasks work', exact: true }).click()
      const tasks = settings.getByRole('region', { name: 'How tasks work' })
      await tasks.waitFor()
      const wording = tasks.locator('details').first()
      expect(await wording.getAttribute('open')).toBeNull()
      await wording.locator('summary').click()
      expect(await wording.innerText()).toContain('Adds:')
    } finally {
      world.stores['vm-str'].set('notify', null, { space: '~' })
      world.sections = demoSettings(world.stores)
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)

  test('the scope sits above the page it edits; a page that is one for all, or this device’s, says so (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(url())
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Settings' })
    const nav = settings.getByRole('navigation', { name: 'Sections' })
    await nav.getByRole('button', { name: 'Notifications', exact: true }).click()
    // the space it opened from, named with its machine
    const pick = settings.getByRole('button', { name: 'Editing: home · vm-str' })
    await pick.waitFor()
    await pick.click()
    await page.getByRole('menuitemradio', { name: 'Everywhere', exact: true }).click()
    await settings.getByRole('button', { name: 'Editing: Everywhere' }).waitFor()
    // one for all, and each device's own: their words, not a picker
    await nav.getByRole('button', { name: 'Plugins', exact: true }).click()
    expect(await settings.textContent()).toContain('Editing:Everywhere')
    expect(await settings.getByRole('button', { name: /^Editing: / }).count()).toBe(0)
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
    expect(await settings.textContent()).toContain('Editing:This device')
    await page.close()
  }, 30_000)

  test('many machines and home spaces: the picker can be searched, and the pick carries into the page (phone)', async () => {
    const before = { machines: world.machines, places: world.places, sections: world.sections }
    const home = world.places.find((p) => p.id === 'p:vm-str:~')!
    const names = Array.from({ length: 6 }, (_, i) => `machine-${i + 1}`)
    world.machines = [...world.machines, ...names.map((m) => ({ ...world.machines[0], id: `m:${m}`, machine: m, name: m }))]
    world.places = [...world.places, ...names.map((m) => ({ ...home, id: `p:${m}:~`, machine: m, name: 'home' }))]
    // a home space of its own on each, so the picker has that level to offer
    world.sections = [...world.sections, ...names.flatMap((m) => before.sections.filter((s) => s.level === home.id).map((s) => ({ ...s, level: `p:${m}:~` })))]
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      const list = settings.getByRole('navigation', { name: 'Sections' })
      await list.getByRole('button', { name: 'Editing: home · vm-str', exact: true }).click()
      // too many to read through: typed words narrow it to the one
      await page.getByRole('textbox', { name: 'Find scope or value' }).fill('home · machine-6')
      const menu = page.getByRole('menu', { name: 'Choices' })
      expect(await menu.getByRole('menuitemradio').count()).toBe(1)
      await menu.getByRole('menuitemradio', { name: 'home · machine-6', exact: true }).click()
      await list.getByRole('button', { name: 'Editing: home · machine-6', exact: true }).waitFor()
      // the page it opens edits that level, and fits the phone
      await list.getByRole('button', { name: 'Notifications', exact: true }).click()
      const notify = settings.getByRole('region', { name: 'Notifications' })
      await notify.getByRole('button', { name: 'Editing: home · machine-6', exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    } finally {
      Object.assign(world, before)
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)
})

describe.skipIf(!browser)('chat agent choices', () => {
  test('Agents says why only some CLIs can hold a chat, and offers only those for Tasks, Coordinators and Backup (phone)', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click()
      const agents = settings.getByRole('region', { name: 'Agents' })
      await agents.waitFor()
      expect(await agents.textContent()).toContain('Chat choices need a chat log reader')
      expect(await agents.textContent()).toContain('Headless review is separate')
      for (const group of ['Tasks', 'Coordinators', 'Backup']) {
        await agents.getByRole('heading', { name: group, exact: true }).locator('..').getByRole('button', { name: /^Agent: / }).click()
        const offered = (await page.getByRole('menuitemradio').allTextContents()).map((v) => v.trim())
        expect(offered.sort()).toEqual((group === 'Backup' ? ['Off', 'Claude Code', 'Codex', 'Pi'] : ['Claude Code', 'Codex', 'Pi']).sort())
        await page.keyboard.press('Escape')
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.close()
    }
  }, 30_000)
})

describe.skipIf(!browser)('task IDs', () => {
  test('a space states its prefix and next number, nothing to reset, and a refused number says why (desktop)', async () => {
    const { taskIdsSection } = await import('../server/live/task-ids.ts')
    const before = { sections: world.sections, act: world.act }
    const level = 'p:vm-str:gtm'
    world.sections = [...before.sections, taskIdsSection(level, 'vm-str', 'GAME', 100)]
    const act = before.act.bind(world)
    // a number going back is the server's refusal, in its own words under the box
    world.act = async (a) => (a.type === 'setting' && a.key === 'taskIds.next' ? { ok: false, error: 'Use 100 or higher. Earlier numbers are reserved.' } : act(a))
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      // every space has its own page, so the home space picked first has none
      expect(await settings.getByRole('button', { name: 'Task IDs', exact: true }).count()).toBe(0)
      await settings.getByRole('button', { name: /^Editing:/ }).click()
      await page.getByRole('menuitemradio', { name: /gtm/ }).click()
      await settings.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Task IDs', exact: true }).click()
      const ids = settings.getByRole('region', { name: 'Task IDs' })
      await ids.getByRole('textbox', { name: 'Prefix', exact: true }).waitFor()
      // two typed values and the ID the next task will get; no inherited value to go back to
      expect(await ids.getByRole('textbox').count()).toBe(2)
      expect(await ids.getByRole('textbox', { name: 'Prefix', exact: true }).inputValue()).toBe('GAME')
      expect(await ids.getByRole('textbox', { name: 'Next number', exact: true }).inputValue()).toBe('100')
      expect(await ids.textContent()).toContain('Next task: GAME-100')
      expect(await ids.getByRole('button', { name: /^Reset to/ }).count()).toBe(0)
      expect(await ids.textContent()).not.toContain('The rest follows')
      // a number that would go back: the box stays as typed, and says what to use instead
      await ids.getByRole('textbox', { name: 'Next number', exact: true }).fill('7')
      await ids.getByRole('textbox', { name: 'Next number', exact: true }).press('Tab')
      await ids.getByRole('status').filter({ hasText: 'Use 100 or higher' }).waitFor()
    } finally {
      world.sections = before.sections
      world.act = before.act
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)
})

describe.skipIf(!browser)('private instructions', () => {
  test('a role’s rules save at the scope picked, a blank there means none, and Reset inherits again (phone)', async () => {
    const store = world.stores['vm-str']
    const before = world.sections
    store.set('task.instructions', 'Everywhere rule.')
    world.sections = demoSettings(world.stores)
    world.emit('snapshot')
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    try {
      await page.goto(url())
      await page.getByRole('button', { name: 'Places' }).click()
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('region', { name: 'Settings' })
      await settings.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Private instructions', exact: true }).click()
      const panel = settings.getByRole('region', { name: 'Private instructions' })
      await panel.getByRole('button', { name: /^Editing:/ }).waitFor()
      const task = panel.getByRole('textbox', { name: 'Task agents', exact: true })
      expect(await task.inputValue()).toBe('Everywhere rule.')
      // typing alone saves nothing: Undo puts back what the page holds
      await task.fill('Unsaved.')
      await panel.getByRole('button', { name: 'Undo', exact: true }).click()
      expect(await task.inputValue()).toBe('Everywhere rule.')
      // saved at this space, and for that role only
      await task.fill('This space only.')
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await panel.getByRole('button', { name: 'Reset to private rules', exact: true }).waitFor()
      expect(store.get('task.instructions', '~')).toBe('This space only.')
      expect(store.get('task.instructions')).toBe('Everywhere rule.')
      expect(store.get('coordinator.instructions', '~')).toBeFalsy()
      // an empty save is a choice: no private rules here, nothing inherited; Reset brings Everywhere's back
      await task.fill('')
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await panel.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'detached' })
      expect(store.get('task.instructions', '~')).toBe('')
      await panel.getByRole('button', { name: 'Reset to private rules', exact: true }).click()
      await panel.getByRole('button', { name: 'Reset to private rules', exact: true }).waitFor({ state: 'detached' })
      expect(await task.inputValue()).toBe('Everywhere rule.')
      expect(await panel.textContent()).toContain('When rules take effect')
    } finally {
      store.set('task.instructions', null, { space: '~' })
      store.set('task.instructions', null)
      world.sections = before
      world.emit('snapshot')
      await page.close()
    }
  }, 30_000)
})
