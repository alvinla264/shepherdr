// Authored for an authorized test host; no local test suites or browser tests (AGENTS.md).
import { afterAll, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMAGE_MAX_BYTES, MARKDOWN_MAX_BYTES, readDocument } from '../server/markdown-preview.ts'
import { links as viewerLinks, table as viewerTable } from './viewer-plugin.ts'

const scratch = mkdtempSync(join(tmpdir(), 'shep-doc-formats-'))
const root = join(scratch, 'root')
mkdirSync(root)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const linux = process.platform === 'linux' ? test : test.skip

/* ---------- raster fixtures ---------- */

function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

let crcTable: Uint32Array | undefined
function crc32(b: Buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** a PNG with the given header, a little image data and its chunks' own CRCs */
function png(width: number, height: number, frames = 0, data = 4) {
  const chunk = (type: string, payload: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(payload.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0)
    return Buffer.concat([head, payload, crc])
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]
  parts.push(chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])))
  if (frames) parts.push(chunk('acTL', Buffer.concat([u32(frames), u32(0)])))
  parts.push(chunk('IDAT', Buffer.alloc(data)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/** a GIF89a with that many image descriptors, each a one-byte frame, optionally declaring a frame rectangle */
function gif(width: number, height: number, frames: number, rect: [number, number] = [width, height]) {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'ascii')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  const parts = [head]
  for (let i = 0; i < frames; i++) {
    const frame = Buffer.alloc(11)
    frame[0] = 0x2c
    frame.writeUInt16LE(rect[0], 5)
    frame.writeUInt16LE(rect[1], 7)
    frame[9] = 0 // no local colour table
    frame[10] = 2 // LZW minimum code size; the empty sub-block run follows
    parts.push(frame, Buffer.from([0x01, 0x00, 0x00]))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

/** a JPEG with a frame header, a scan and its end marker */
function jpeg(width: number, height: number, scan = true) {
  // marker, length (8 + 3 per component), precision, height, width, 3 components: 19 bytes for a baseline frame
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const parts = [Buffer.from([0xff, 0xd8]), sof]
  if (scan) parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9]))
  return Buffer.concat(parts)
}

/** a WebP whose canvas chunk and VP8L payload declare different sizes */
function webpMismatch(canvas: [number, number], frame: [number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.from([0])] : [])])
  }
  const vp8x = Buffer.alloc(10)
  vp8x.writeUIntLE(canvas[0] - 1, 4, 3)
  vp8x.writeUIntLE(canvas[1] - 1, 7, 3)
  const data = Buffer.alloc(9)
  data[0] = 0x2f
  data.writeUInt32LE((frame[0] - 1) | ((frame[1] - 1) << 14), 1)
  const payload = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', data)])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(payload.length + 4, 4)
  head.write('WEBP', 8, 'ascii')
  return Buffer.concat([head, payload])
}

/** a WebP, lossless when still, optionally extended (VP8X canvas), and animated with a frame chunk */
function webp(width: number, height: number, animated = false, extended = false) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.from([0])] : [])])
  }
  const body: Buffer[] = []
  if (!animated) {
    const data = Buffer.alloc(9)
    data[0] = 0x2f
    data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
    if (extended) {
      const vp8x = Buffer.alloc(10)
      vp8x.writeUIntLE(width - 1, 4, 3)
      vp8x.writeUIntLE(height - 1, 7, 3)
      body.push(chunk('VP8X', vp8x), chunk('VP8L', data))
    } else body.push(chunk('VP8L', data))
  } else {
    const vp8x = Buffer.alloc(10)
    vp8x[0] = 0x02 // animation flag
    vp8x.writeUIntLE(width - 1, 4, 3)
    vp8x.writeUIntLE(height - 1, 7, 3)
    body.push(chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6)), chunk('ANMF', Buffer.alloc(16)))
  }
  const payload = Buffer.concat(body)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(payload.length + 4, 4)
  head.write('WEBP', 8, 'ascii')
  return Buffer.concat([head, payload])
}

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
    const bytes = png(1, 1)
    writeFileSync(path, bytes)
    expect(readDocument(path, [root])).toEqual({ path, image: bytes.toString('base64'), mime: 'image/png' })
    const spoof = join(root, 'spoof.png')
    writeFileSync(spoof, '<svg onload="alert(1)"></svg>')
    expect(() => readDocument(spoof, [root])).toThrow()
    const svg = join(root, 'active.svg')
    writeFileSync(svg, '<svg/>')
    expect(() => readDocument(svg, [root])).toThrow()
  })

  linux('serves a real, decodable image of every supported format', () => {
    const real: Record<string, string> = {
      'real.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
      'real.gif': 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'real.jpg': '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'real.webp': 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
      // 12x8 lossy with alpha, VP8X + ALPH + VP8: a real extended still image, not a header alone
      'real-alpha.webp': 'UklGRnAAAABXRUJQVlA4WAoAAAAQAAAACwAABwAAQUxQSBwAAAABDzD/ERFCUSMpzO8KRSr2MIMfNET0vwfbh8kPVlA4IC4AAACQAQCdASoMAAgAAUAmJaACdLoAA5gA/vCbQ/4DdfFtMv/ucD/uyf/2yf+pAAAA',
    }
    for (const [name, base64] of Object.entries(real)) {
      const path = join(root, name)
      writeFileSync(path, Buffer.from(base64, 'base64'))
      const result = readDocument(path, [root])
      expect('image' in result && result.image.length > 0).toBe(true)
    }
  })

  linux('refuses a raster whose own header claims more than a preview may decode', () => {
    // A few hundred compressed bytes can claim a gigapixel: only the header can bound what the browser decodes.
    const hugePng = join(root, 'huge.png')
    writeFileSync(hugePng, png(60_000, 60_000))
    expect(() => readDocument(hugePng, [root])).toThrow('too large')
    const longPng = join(root, 'long.png')
    writeFileSync(longPng, png(1, 40_000))
    expect(() => readDocument(longPng, [root])).toThrow('too large')
    const hugeJpeg = join(root, 'huge.jpg')
    writeFileSync(hugeJpeg, jpeg(20_000, 20_000))
    expect(() => readDocument(hugeJpeg, [root])).toThrow('too large')
    // the same limits on the other side: a preview-sized image still goes through
    const okJpeg = join(root, 'ok.jpg')
    writeFileSync(okJpeg, jpeg(600, 400))
    expect(readDocument(okJpeg, [root])).toMatchObject({ mime: 'image/jpeg' })
    const okWebp = join(root, 'ok.webp')
    writeFileSync(okWebp, webp(800, 600))
    expect(readDocument(okWebp, [root])).toMatchObject({ mime: 'image/webp' })
    // an extended still image (canvas and alpha chunks, pixels in VP8L) is a picture too
    const extendedWebp = join(root, 'extended.webp')
    writeFileSync(extendedWebp, webp(640, 480, false, true))
    expect(readDocument(extendedWebp, [root])).toMatchObject({ mime: 'image/webp' })
  })

  linux('refuses animation, and a header it cannot read', () => {
    const stillGif = join(root, 'still.gif')
    writeFileSync(stillGif, gif(40, 30, 1))
    expect(readDocument(stillGif, [root])).toMatchObject({ mime: 'image/gif' })
    const animatedGif = join(root, 'animated.gif')
    writeFileSync(animatedGif, gif(40, 30, 3))
    expect(() => readDocument(animatedGif, [root])).toThrow('Animated')
    const animatedPng = join(root, 'animated.png')
    writeFileSync(animatedPng, png(10, 10, 4))
    expect(() => readDocument(animatedPng, [root])).toThrow('Animated')
    const animatedWebp = join(root, 'animated.webp')
    writeFileSync(animatedWebp, webp(100, 100, true))
    expect(() => readDocument(animatedWebp, [root])).toThrow('Animated')
    // A magic number alone is not a header: an unreadable one is refused, never assumed small.
    const truncated = join(root, 'truncated.png')
    writeFileSync(truncated, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]))
    expect(() => readDocument(truncated, [root])).toThrow('header')
    // a chunk that announces no IHDR length is not a header either
    const noLength = join(root, 'no-length.png')
    writeFileSync(noLength, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4), Buffer.from('IHDR'), Buffer.alloc(17)]))
    expect(() => readDocument(noLength, [root])).toThrow('header')
    const truncatedGif = join(root, 'truncated.gif')
    writeFileSync(truncatedGif, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)]))
    expect(() => readDocument(truncatedGif, [root])).toThrow()
  })

  linux('refuses bytes that do not match the structure they announce', () => {
    // a chunk whose CRC does not match is not the chunk it claims to be
    const badCrc = join(root, 'bad-crc.png')
    const good = png(4, 4)
    const wrong = Buffer.from(good)
    wrong[wrong.length - 5] ^= 0xff // inside IEND's CRC
    writeFileSync(badCrc, wrong)
    expect(() => readDocument(badCrc, [root])).toThrow()
    // an image with no image data is not a picture
    const emptyData = join(root, 'empty-data.png')
    writeFileSync(emptyData, png(4, 4, 0, 0))
    expect(() => readDocument(emptyData, [root])).toThrow('header')
    // a frame header without its scan and end marker
    const frameOnly = join(root, 'frame-only.jpg')
    writeFileSync(frameOnly, jpeg(40, 30, false))
    expect(() => readDocument(frameOnly, [root])).toThrow('header')
    // a RIFF header that claims more file than there is
    const shortFile = join(root, 'short.webp')
    const whole = webp(20, 10)
    whole.writeUInt32LE(whole.length + 100, 4)
    writeFileSync(shortFile, whole)
    expect(() => readDocument(shortFile, [root])).toThrow('header')
    // the IHDR's own CRC is checked too: its data cannot be edited unnoticed
    const ihdrCrc = join(root, 'ihdr-crc.png')
    const shifted = Buffer.from(png(8, 8))
    shifted[29] ^= 0xff // the IHDR CRC, which sits at 8 + 4 + 4 + 13
    writeFileSync(ihdrCrc, shifted)
    expect(() => readDocument(ihdrCrc, [root])).toThrow()
    // IEND has no payload; one that carries bytes is not an end chunk
    const badEnd = join(root, 'bad-end.png')
    const basePng = png(8, 8)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(1, 0)
    head.write('IEND', 4, 'ascii')
    const endCrc = Buffer.alloc(4)
    endCrc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), Buffer.from([0])])), 0)
    writeFileSync(badEnd, Buffer.concat([basePng.subarray(0, basePng.length - 12), head, Buffer.from([0]), endCrc]))
    expect(() => readDocument(badEnd, [root])).toThrow()
    // a canvas and a payload that disagree: the payload may not claim more than the canvas
    const mismatch = join(root, 'mismatch.webp')
    writeFileSync(mismatch, webpMismatch([1, 1], [4000, 4000]))
    expect(() => readDocument(mismatch, [root])).toThrow('header')
    // a GIF frame rectangle larger than the logical screen still asks for that much
    const bigFrame = join(root, 'big-frame.gif')
    writeFileSync(bigFrame, gif(8, 8, 1, [20_000, 20_000]))
    expect(() => readDocument(bigFrame, [root])).toThrow('too large')
    // a RIFF length smaller than the file leaves the image chunk outside the declared boundary
    const shortRiff = join(root, 'short-riff.webp')
    const lying = Buffer.from(webp(20, 10))
    lying.writeUInt32LE(4, 4)
    writeFileSync(shortRiff, lying)
    expect(() => readDocument(shortRiff, [root])).toThrow('header')
    // an odd-sized chunk without its padding byte
    const noPadding = join(root, 'no-padding.webp')
    const padded = webp(20, 10)
    const odd = Buffer.from(padded.subarray(0, padded.length - 1))
    odd.writeUInt32LE(odd.length - 8, 4)
    writeFileSync(noPadding, odd)
    expect(() => readDocument(noPadding, [root])).toThrow()
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
  // The viewer plugin's own helpers (test/viewer-plugin.ts): staged here for a build, absent on a clean checkout.
  test.skipIf(!viewerLinks)('links remain same-origin and explicitly allowlisted', () => {
    const o = 'https://shepherdr.example'
    for (const ext of ['png', 'jpg', 'gif', 'webp', 'txt', 'csv', 'tsv', 'py']) expect(viewerLinks!.documentLink(`/home/a/file.${ext}`, o)).not.toBeNull()
    for (const ext of ['svg', 'pdf', 'docx', 'xls', 'pptx', 'exe']) expect(viewerLinks!.documentLink(`/home/a/file.${ext}`, o)).toBeNull()
    expect(viewerLinks!.documentLink('https://other.example/home/a/file.png', o)).toBeNull()
  })
  test.skipIf(!viewerTable)('CSV handles quoted separators, escaped quotes, multiline fields and rendering bounds', () => {
    expect(viewerTable!.previewTable('a,"b,c"\r\n"one\ntwo","x""y"', ',').rows).toEqual([['a', 'b,c'], ['one\ntwo', 'x"y']])
    expect(viewerTable!.previewTable('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(viewerTable!.previewTable('a,b,c\n1,2,3', ',', 1, 2).truncated).toBe(true)
    expect(viewerTable!.previewTable('abcdef', ',', 5, 5, 3)).toEqual({ rows: [['abc']], truncated: true })
    expect(() => viewerTable!.previewTable('"open', ',')).toThrow()
  })
})
