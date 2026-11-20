// Authored for an authorized test host; no local test suites or browser tests (AGENTS.md).
import { afterAll, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMAGE_MAX_BYTES, MARKDOWN_MAX_BYTES, readDocument } from '../server/markdown-preview.ts'
import { documentLink } from '../user-plugins/markdown-preview/links.ts'
import { previewTable } from '../user-plugins/markdown-preview/table.ts'

const scratch = mkdtempSync(join(tmpdir(), 'shep-doc-formats-'))
const root = join(scratch, 'root')
mkdirSync(root)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const linux = process.platform === 'linux' ? test : test.skip

describe('explicit document formats', () => {
  linux('text, code and tables retain UTF-8 source without interpreting HTML', () => {
    for (const ext of ['txt', 'log', 'json', 'py', 'rs', 'csv', 'tsv']) {
      const path = join(root, `note.${ext}`)
      writeFileSync(path, '<script>not active</script>')
      expect(readDocument(path, [root])).toEqual({ path, text: '<script>not active</script>' })
    }
  })
  linux('only matching raster magic bytes are accepted and returned as JSON-safe base64', () => {
    const path = join(root, 'picture.png')
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3])
    writeFileSync(path, bytes)
    expect(readDocument(path, [root])).toEqual({ path, image: bytes.toString('base64'), mime: 'image/png' })
    const spoof = join(root, 'spoof.png')
    writeFileSync(spoof, '<svg onload="alert(1)"></svg>')
    expect(() => readDocument(spoof, [root])).toThrow()
    const svg = join(root, 'active.svg')
    writeFileSync(svg, '<svg/>')
    expect(() => readDocument(svg, [root])).toThrow()
  })
  linux('same containment, links, file size and UTF-8 restrictions apply to new types', () => {
    const outside = join(scratch, 'outside.txt')
    writeFileSync(outside, 'private')
    symlinkSync(outside, join(root, 'linked.txt'))
    linkSync(outside, join(root, 'hard.txt'))
    for (const path of [outside, join(root, 'linked.txt'), join(root, 'hard.txt')]) expect(() => readDocument(path, [root])).toThrow()
    const bigText = join(root, 'big.txt')
    writeFileSync(bigText, Buffer.alloc(MARKDOWN_MAX_BYTES + 1, 65))
    expect(() => readDocument(bigText, [root])).toThrow()
    const bigImage = join(root, 'big.png')
    writeFileSync(bigImage, Buffer.alloc(IMAGE_MAX_BYTES + 1))
    expect(() => readDocument(bigImage, [root])).toThrow()
    const invalid = join(root, 'invalid.txt')
    writeFileSync(invalid, Buffer.from([0xff]))
    expect(() => readDocument(invalid, [root])).toThrow()
  })
  test('links remain same-origin and explicitly allowlisted', () => {
    const o = 'https://shepherdr.example'
    for (const ext of ['png', 'jpg', 'gif', 'webp', 'txt', 'csv', 'tsv', 'py']) expect(documentLink(`/home/a/file.${ext}`, o)).not.toBeNull()
    for (const ext of ['svg', 'pdf', 'docx', 'xls', 'pptx', 'exe']) expect(documentLink(`/home/a/file.${ext}`, o)).toBeNull()
    expect(documentLink('https://other.example/home/a/file.png', o)).toBeNull()
  })
  test('CSV handles quoted separators, escaped quotes, multiline fields and rendering bounds', () => {
    expect(previewTable('a,"b,c"\r\n"one\ntwo","x""y"', ',').rows).toEqual([['a', 'b,c'], ['one\ntwo', 'x"y']])
    expect(previewTable('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(previewTable('a,b,c\n1,2,3', ',', 1, 2).truncated).toBe(true)
    expect(previewTable('abcdef', ',', 5, 5, 3)).toEqual({ rows: [['abc']], truncated: true })
    expect(() => previewTable('"open', ',')).toThrow()
  })
})
