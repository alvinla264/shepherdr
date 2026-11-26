// A task's Files view draws a file by its kind: Markdown as the chat's prose, HTML sealed in a frame, code as before
// (layout.ts).
import { describe, expect, test } from 'bun:test'
import { sealedPage } from '../shared/sealed.ts'
import { layout } from './layout.ts'

const { browser, server } = await layout()

// the seal is a meta, and a meta CSP only covers what comes after it: so it goes before everything the page wrote,
// even a `<head>` inside a script string or a comment
test('an agent page gets its seal first, whatever it starts with', () => {
  for (const html of ['<script>const tpl = "<head>"</script><img src="https://example.com/x.png">', '<!-- <head> --><p>hi</p>', '<p>hi</p>']) {
    const page = sealedPage(html)
    expect(page.startsWith('<!doctype html>')).toBe(true)
    // the seal comes before the page's own first character, so it governs all of them
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf(html))
    // the page's own words are kept whole: nothing was spliced into their middle
    expect(page.endsWith(html)).toBe(true)
    expect(page.match(/<!doctype/gi)?.length).toBe(1)
  }
  const withDoctype = sealedPage('<!doctype html>\n<p>hi</p>')
  expect(withDoctype.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(withDoctype.endsWith('\n<p>hi</p>')).toBe(true)
})

describe.skipIf(!browser)("a worktree's files by their kind", () => {
  const task = (id: string) => `http://127.0.0.1:${server!.port}/?place=p:vm-str:gtm&task=${id}`
  const frameSel = 'iframe[title="docs/page.html preview"]'

  test('Markdown reads as a document, HTML as a sealed frame, code still as code (desktop)', async () => {
    const page = await browser!.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(task('GTM-15'))
    await page.getByRole('button', { name: 'Show task panel' }).click()
    await page.getByRole('tab', { name: 'Files' }).click()
    const panel = page.locator('#task-panel')
    const tree = panel.getByRole('tree', { name: 'Files' })

    // a .md file: its heading and its list, no '#' or '- ' marks
    await tree.getByRole('treeitem', { name: 'docs' }).click()
    await tree.getByRole('treeitem', { name: 'report.md' }).click()
    const doc = panel.locator('.prose-doc')
    await doc.getByRole('heading', { name: 'Q3 report' }).waitFor()
    expect(await doc.locator('li').allTextContents()).toEqual(['Webhooks are live', 'Enrichment covers three providers', 'Outbound starts next week'])
    expect(await doc.getByText('# Q3 report').count()).toBe(0)
    expect(await doc.getByText('- Webhooks are live').count()).toBe(0)
    // and it sits where the code view sits, under the file's bar
    expect(await panel.locator('.code-view').count()).toBe(0)

    // a .html file: a frame of its own, its script run, the seal in the head before its content
    await panel.getByRole('button', { name: 'All files' }).click()
    // the folder stays open across a pick, so page.html is already in the tree
    await tree.getByRole('treeitem', { name: 'page.html' }).click()
    await panel.locator(frameSel).waitFor()
    expect(await panel.locator(frameSel).getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    const srcdoc = (await panel.locator(frameSel).getAttribute('srcdoc'))!
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<h1>Enrichment preview'))
    expect(await panel.getByText('<!doctype html>').count()).toBe(0)
    const inside = page.frameLocator(frameSel)
    await inside.getByRole('heading', { name: 'Enrichment preview' }).waitFor()
    expect(await inside.getByText('Acme Ltd').count()).toBe(1)
    // the browser put the policy in the page's head, where it governs the whole document
    const pageFrame = page.frames().find((f) => f !== page.mainFrame())!
    expect(await pageFrame.evaluate(() => document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '')).toContain("default-src 'none'")

    // a .ts file: the highlighted code view, as it always was
    await panel.getByRole('button', { name: 'All files' }).click()
    await tree.getByRole('treeitem', { name: 'src' }).click()
    await tree.getByRole('treeitem', { name: 'server.ts' }).click()
    await panel.locator('.code-view').getByText('Bun', { exact: false }).first().waitFor()
    expect(await panel.locator('.code-view tr').count()).toBe(10)
    await page.close()
  }, 30_000)
})
