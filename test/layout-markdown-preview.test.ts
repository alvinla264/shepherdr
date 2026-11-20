// Requires the private markdown-preview plugin staged in user-plugins before the screen is built.
// Authored only: never run browser tests on the live Herdr machine.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'

const { browser, server } = await layout()

describe.skipIf(!browser)('Markdown side preview', () => {
  test('opens beside chat, renders safely, follows relative links, and closes without a new page', async () => {
    const page = await browser!.newPage({ viewport: { width: 1800, height: 1000 } })
    const origin = `http://127.0.0.1:${server!.port}`
    let images = 0
    page.on('request', (r) => { if (r.url().includes('tracking.invalid')) images++ })
    await page.route('**/api/markdown-preview?*', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')!
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ path, text: path.endsWith('next.md') ? '# Next\n' : '# Design\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst n = 1\n```\n\n![tracking](https://tracking.invalid/pixel)\n\n<script>window.mdExecuted = true</script>\n\n<img src="https://tracking.invalid/raw">\n\n[Next](next.md)\n' }) })
    })
    await page.goto(`${origin}/?place=vm-str/home`)
    await page.getByRole('textbox', { name: /^Message home/ }).waitFor()
    await page.evaluate(() => {
      const box = document.createElement('div')
      box.className = 'prose-reply'
      box.innerHTML = '<a href="/home/example/docs/design.md" target="_blank">Preview fixture</a>'
      box.style.cssText = 'position:fixed;left:350px;top:150px;z-index:50'
      document.body.append(box)
    })
    const count = page.context().pages().length
    await page.getByRole('link', { name: 'Preview fixture' }).click()
    const panel = page.getByRole('complementary', { name: 'Document preview' })
    await panel.getByRole('heading', { name: 'Design' }).waitFor()
    expect(await panel.locator('table').count()).toBe(1)
    expect(await panel.locator('pre code').textContent()).toContain('const n = 1')
    expect(await panel.locator('img,script,iframe,style,form').count()).toBe(0)
    expect(images).toBe(0)
    const chat = (await page.getByRole('textbox', { name: /^Message home/ }).boundingBox())!
    const side = (await panel.boundingBox())!
    expect(chat.x + chat.width).toBeLessThanOrEqual(side.x)
    expect(page.context().pages().length).toBe(count)
    await panel.getByRole('link', { name: 'Next', exact: true }).click()
    await panel.getByRole('heading', { name: 'Next', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    expect(await page.locator('body').getAttribute('data-markdown-docked')).toBeNull()
    await page.close()
  }, 30_000)

  test('HTML preserves inline styles and static SVG inside an opaque, network-blocked sandbox', async () => {
    const page = await browser!.newPage({ viewport: { width: 1800, height: 1000 } })
    const origin = `http://127.0.0.1:${server!.port}`
    const fixture = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://tracking.invalid/refresh">
      <base href="https://tracking.invalid/"><link rel="stylesheet" href="https://tracking.invalid/style.css">
      <style>@import url(https://tracking.invalid/import.css); body{background:rgb(1,2,3)} h1{color:rgb(4,5,6)} .probe{background-image:url(https://tracking.invalid/css-image)}</style>
      </head><body><h1>HTML diagram</h1><div class="probe">Static content</div>
      <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="red" /></svg>
      <script>window.htmlExecuted=true;fetch('https://tracking.invalid/script')</script>
      <img src="https://tracking.invalid/image" onerror="window.htmlExecuted=true">
      <iframe src="https://tracking.invalid/frame"></iframe>
      <form action="https://tracking.invalid/form"><button>Send</button></form>
      <a href="https://tracking.invalid/link" target="_top">Disabled link</a>
      </body></html>`
    let externalRequests = 0
    page.on('request', (request) => { if (request.url().includes('tracking.invalid')) externalRequests++ })
    await page.route('https://tracking.invalid/**', (route) => route.abort())
    await page.route('**/api/markdown-preview?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ path: '/home/example/docs/diagram.html', text: fixture }) }))
    await page.goto(`${origin}/?place=vm-str/home`)
    await page.getByRole('textbox', { name: /^Message home/ }).waitFor()
    await page.evaluate(() => {
      const link = document.createElement('div')
      link.className = 'prose-reply'
      link.innerHTML = '<a href="/home/example/docs/diagram.html" target="_blank">HTML fixture</a>'
      link.style.cssText = 'position:fixed;left:350px;top:150px;z-index:50'
      document.body.append(link)
    })
    const count = page.context().pages().length
    await page.getByRole('link', { name: 'HTML fixture' }).click()
    const panel = page.getByRole('complementary', { name: 'Document preview' })
    const frame = panel.locator('iframe[title="HTML document preview"]')
    await frame.waitFor()
    expect(await frame.getAttribute('sandbox')).toBe('')
    expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    const content = page.frameLocator('iframe[title="HTML document preview"]')
    await content.getByRole('heading', { name: 'HTML diagram' }).waitFor()
    expect(await content.locator('svg circle').count()).toBe(1)
    expect(await content.locator('h1').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(4, 5, 6)')
    expect(await content.locator('script,img,iframe,form,button,base,link').count()).toBe(0)
    expect(await content.locator('a').getAttribute('href')).toBeNull()
    expect(await content.locator('meta[http-equiv="refresh"]').count()).toBe(0)
    expect(await content.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("default-src 'none'")
    const handle = await frame.elementHandle()
    const isolated = (await handle!.contentFrame())!
    expect(await isolated.evaluate(() => {
      try { void parent.document.body; return false } catch { return true }
    })).toBe(true)
    expect(await isolated.evaluate(() => 'htmlExecuted' in window)).toBe(false)
    await page.waitForTimeout(200)
    expect(externalRequests).toBe(0)
    expect(page.context().pages().length).toBe(count)
    expect(page.url()).toBe(`${origin}/?place=vm-str/home`)
    await panel.getByRole('button', { name: 'Close document preview' }).click()
    await panel.waitFor({ state: 'detached' })
    await page.close()
  }, 30_000)

  test('shows CSV and literal code in the same side panel without running embedded HTML', async () => {
    const page = await browser!.newPage({ viewport: { width: 1600, height: 900 } })
    await page.route('**/api/markdown-preview?*', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')!
      const text = path.endsWith('.csv') ? 'name,value\n"hello, world",2' : '<script>window.previewExecuted=true</script>'
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ path, text }) })
    })
    await page.goto(`http://127.0.0.1:${server!.port}/?place=vm-str/home`)
    await page.getByRole('textbox', { name: /^Message home/ }).waitFor()
    await page.evaluate(() => {
      const box = document.createElement('div')
      box.className = 'prose-reply'
      box.innerHTML = '<a href="/home/example.csv">Table fixture</a> <a href="/home/example.py">Code fixture</a>'
      box.style.cssText = 'position:fixed;left:350px;top:150px;z-index:50'
      document.body.append(box)
    })
    const count = page.context().pages().length
    await page.getByRole('link', { name: 'Table fixture' }).click()
    const panel = page.getByRole('complementary', { name: 'Document preview' })
    await panel.getByText('hello, world').waitFor()
    expect(await panel.locator('table tr').count()).toBe(2)
    await page.getByRole('link', { name: 'Code fixture' }).click()
    await panel.getByText('<script>window.previewExecuted=true</script>').waitFor()
    expect(await panel.locator('script').count()).toBe(0)
    expect(await page.evaluate(() => 'previewExecuted' in window)).toBe(false)
    expect(page.context().pages().length).toBe(count)
    await page.close()
  }, 30_000)

  test('shows a bounded error instead of navigating back to chat', async () => {
    const page = await browser!.newPage({ viewport: { width: 1600, height: 900 } })
    await page.route('**/api/markdown-preview?*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Markdown document unavailable.' }) }))
    await page.goto(`http://127.0.0.1:${server!.port}/?place=vm-str/home`)
    await page.getByRole('textbox', { name: /^Message home/ }).waitFor()
    const before = page.url()
    await page.evaluate(() => {
      const box = document.createElement('div')
      box.className = 'prose-reply'
      box.innerHTML = '<a href="/home/missing.md">Missing Markdown</a>'
      box.style.cssText = 'position:fixed;left:350px;top:150px;z-index:50'
      document.body.append(box)
    })
    await page.getByRole('link', { name: 'Missing Markdown' }).click()
    await page.getByRole('alert').filter({ hasText: 'Markdown document unavailable.' }).waitFor()
    expect(page.url()).toBe(before)
    await page.getByRole('button', { name: 'Close document preview' }).click()
    await page.close()
  }, 30_000)
})
