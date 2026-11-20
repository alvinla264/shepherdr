// Authored for CI/offline review. Do not run on the live Herdr machine (AGENTS.md).
import { afterAll, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKDOWN_MAX_BYTES, markdownResponse, readMarkdown, readDocument } from '../server/markdown-preview.ts'
import { sameSite } from '../server/app.ts'
import { links as viewerLinks } from './viewer-plugin.ts'

const scratch = mkdtempSync(join(tmpdir(), 'shepherdr-markdown-test-'))
const root = join(scratch, 'approved')
mkdirSync(root)
const file = join(root, 'design.md')
writeFileSync(file, '# Design\n\n| A | B |\n|---|---|\n| 1 | 2 |\n')
const outside = join(scratch, 'private.md')
writeFileSync(outside, 'PRIVATE FIXTURE')
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const linux = process.platform === 'linux' ? test : test.skip

describe('approved Markdown reader', () => {
  linux('reads only a regular UTF-8 Markdown file in an explicit root', () => {
    const result = readMarkdown(file, [root])
    expect('text' in result && result.text.startsWith('# Design')).toBe(true)
    expect(() => readMarkdown(file, [])).toThrow()
    expect(() => readMarkdown(outside, [root])).toThrow()
  })
  linux('returns HTML/HTM as JSON text, under the same boundaries as Markdown', async () => {
    const html = join(root, 'diagram.html')
    const htm = join(root, 'diagram.HTM')
    const source = '<!doctype html><style>h1{color:red}</style><h1>Diagram</h1><script>alert(1)</script>'
    writeFileSync(html, source)
    writeFileSync(htm, source)
    expect(readDocument(html, [root])).toEqual({ path: html, text: source })
    expect(readDocument(htm, [root])).toEqual({ path: htm, text: source })
    const response = markdownResponse(new Request(`http://localhost/api/markdown-preview?${new URLSearchParams({ path: html })}`, { headers: { 'x-shepherdr': '1' } }), [root])
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await response.json()).text).toBe(source)
    const secret = join(scratch, 'private.html')
    writeFileSync(secret, 'PRIVATE HTML FIXTURE')
    symlinkSync(secret, join(root, 'linked.html'))
    expect(() => readDocument(secret, [root])).toThrow()
    expect(() => readDocument(join(root, 'linked.html'), [root])).toThrow()
    const large = join(root, 'large.html')
    writeFileSync(large, Buffer.alloc(MARKDOWN_MAX_BYTES + 1, 65))
    expect(() => readDocument(large, [root])).toThrow()
  })
  linux('rejects prefix siblings, traversal, hidden paths, wrong extensions, and absent files', () => {
    const sibling = `${root}-other`
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'file.md'), 'outside')
    writeFileSync(join(root, '.secret.md'), 'hidden')
    writeFileSync(join(root, 'config.exe'), 'not supported')
    for (const path of [join(sibling, 'file.md'), `${root}/../private.md`, `${root}/.secret.md`, join(root, 'config.exe'), join(root, 'missing.md'), root, `${file}\0`]) {
      expect(() => readMarkdown(path, [root])).toThrow()
    }
  })
  linux('rejects final and intermediate symlinks, symlink roots, and hardlinks', () => {
    symlinkSync(outside, join(root, 'linked.md'))
    symlinkSync(scratch, join(root, 'linked-dir'))
    symlinkSync(root, join(scratch, 'root-link'))
    linkSync(outside, join(root, 'hardlinked.md'))
    for (const path of [join(root, 'linked.md'), join(root, 'linked-dir', 'private.md'), join(root, 'hardlinked.md')]) expect(() => readMarkdown(path, [root])).toThrow()
    expect(() => readMarkdown(join(scratch, 'root-link', 'design.md'), [join(scratch, 'root-link')])).toThrow()
  })
  linux('bounds size and rejects binary and invalid UTF-8', () => {
    for (const [name, data] of [['big.md', Buffer.alloc(MARKDOWN_MAX_BYTES + 1, 65)], ['binary.md', Buffer.from([65, 0, 66])], ['invalid.md', Buffer.from([0xff])]] as const) {
      const path = join(root, name)
      writeFileSync(path, data)
      expect(() => readMarkdown(path, [root])).toThrow()
    }
  })
  linux('does not cache content and refuses passive cross-origin reads', async () => {
    const url = `http://localhost/api/markdown-preview?${new URLSearchParams({ path: file })}`
    expect(markdownResponse(new Request(url), [root]).status).toBe(403)
    const response = markdownResponse(new Request(url, { headers: { 'x-shepherdr': '1' } }), [root])
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).path).toBe(file)
    expect(sameSite(new Request(url, { headers: { 'sec-fetch-site': 'cross-site' } }), '/api/markdown-preview')).toBe(false)
    expect(markdownResponse(new Request(url, { method: 'POST', headers: { 'x-shepherdr': '1' } }), [root]).status).toBe(405)
  })
})

// The viewer plugin's own URL helper (test/viewer-plugin.ts): staged here for a build, absent on a clean checkout.
describe.skipIf(!viewerLinks)('document URL resolution', () => {
  const origin = 'https://shepherdr.example'
  const documentLink = (...args: Parameters<NonNullable<typeof viewerLinks>['documentLink']>) => viewerLinks!.documentLink(...args)
  test('handles existing filesystem links, URL encoding, relative documents, and headings', () => {
    expect(documentLink(`${origin}/home/a/design.md`, origin)?.path).toBe('/home/a/design.md')
    expect(documentLink('/home/a/design%20notes.md', origin)?.path).toBe('/home/a/design notes.md')
    expect(documentLink('other.md#heading', origin, '/home/a/design.md')).toEqual({ path: '/home/a/other.md', hash: '#heading' })
    expect(documentLink('#heading', origin, '/home/a/design.md')?.path).toBe('/home/a/design.md')
    expect(documentLink('/home/a/diagram.html', origin)?.path).toBe('/home/a/diagram.html')
    expect(documentLink('/home/a/diagram.HTM', origin)?.path).toBe('/home/a/diagram.HTM')
    expect(documentLink('diagram.html', origin, '/home/a/design.md')?.path).toBe('/home/a/diagram.html')
    expect(documentLink('https://evil.invalid/design.html', origin)).toBeNull()
    expect(documentLink('/home/a/diagram.xhtml', origin)).toBeNull()
  })
  test('leaves external sites alone and rejects unexpected schemes and malformed encoding', () => {
    for (const href of ['https://evil.invalid/home/private.md', '//evil.invalid/readme.md', 'file:///home/private.md', 'javascript:alert(1)', '/bad%ZZ.md', '/bad%00.md', '/x.md?download=1']) expect(documentLink(href, origin)).toBeNull()
  })
})
