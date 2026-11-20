// Local-only Markdown/HTML reader. HTML is returned as JSON text, never as a navigable HTML response.
// A raster's compressed size bounds nothing about what a browser decodes: one 8 MiB file can claim millions of pixels
// or endless frames. The header's own numbers are checked below, so an oversized or animated image is refused rather
// than handed to the panel: that is the one behaviour change for readers (animated GIF/WebP/APNG are not previewed).
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { HOME } from './store.ts'

export const MARKDOWN_MAX_BYTES = 512 * 1024
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** the most a preview may ask a browser to decode: 16 megapixels, and no side over 12000 */
export const RASTER_MAX_PIXELS = 16_000_000
export const RASTER_MAX_SIDE = 12_000
const TEXT_EXT = /\.(?:md|html?|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|xml|sh|bash|zsh|py|js|jsx|ts|tsx|css|c|h|cc|cpp|hpp|rs|go|java|sql|nix|diff|patch)$/i
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i

/** Verify both the extension and magic bytes. SVG and unknown image types are not served. */
function imageMime(path: string, b: Buffer): string | undefined {
  if (/\.png$/i.test(path) && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (/\.jpe?g$/i.test(path) && b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (/\.gif$/i.test(path) && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (/\.webp$/i.test(path) && b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

let crcTable: Uint32Array | undefined
/** PNG chunks carry their own CRC: a chunk that fails it is not the chunk it claims to be */
function crc32(b: Buffer, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** what a decoder will do, from the file's own headers; undefined when they cannot be read (fail closed) */
export interface RasterWorkload {
  width: number
  height: number
  frames: number
}

function pngWorkload(b: Buffer): RasterWorkload | undefined {
  // the signature, then a first chunk that is a complete IHDR, then whole chunks each with a matching CRC
  if (b.length < 33 || b.toString('ascii', 1, 4) !== 'PNG') return
  let width = 0
  let height = 0
  let frames = 1
  let first = true
  let dataBytes = 0
  let end = false
  for (let p = 8; p + 8 <= b.length; ) {
    const length = b.readUInt32BE(p)
    const type = b.toString('ascii', p + 4, p + 8)
    const next = p + 12 + length
    if (length > b.length || next > b.length) return
    if (crc32(b, p + 4, next - 4) !== b.readUInt32BE(next - 4)) return
    if (first) {
      if (type !== 'IHDR' || length !== 13) return
      width = b.readUInt32BE(p + 8)
      height = b.readUInt32BE(p + 12)
      first = false
    }
    // an APNG announces its frame count in acTL, before the first frame
    if (type === 'acTL') {
      if (length !== 8) return
      frames = Math.max(1, b.readUInt32BE(p + 8))
    }
    if (type === 'IDAT') dataBytes += length
    if (type === 'IEND') {
      if (length !== 0) return
      end = true
      break
    }
    p = next
  }
  if (first || !dataBytes || !end || !width || !height) return
  return { width, height, frames }
}

function gifWorkload(b: Buffer): RasterWorkload | undefined {
  if (b.length < 13) return
  let width = b.readUInt16LE(6)
  let height = b.readUInt16LE(8)
  let p = 13
  if (b[10] & 0x80) p += 3 * 2 ** ((b[10] & 7) + 1)
  let frames = 0
  let trailer = false
  const skip = () => {
    for (;;) {
      if (p >= b.length) throw new Error('truncated')
      const n = b[p++]
      if (!n) return
      p += n
    }
  }
  try {
    while (p < b.length) {
      const block = b[p++]
      if (block === 0x3b) { trailer = true; break }
      else if (block === 0x21) { p++; skip() } // an extension: comment, graphic control, plain text
      else if (block === 0x2c) {
        if (p + 9 > b.length) return
        frames++
        // a frame rectangle that claims more than the logical screen still asks a decoder for that much
        // (left, top, width, height, flags: the width is the third pair, the height the fourth)
        width = Math.max(width, b.readUInt16LE(p + 4))
        height = Math.max(height, b.readUInt16LE(p + 6))
        const flags = b[p + 8]
        p += 9
        if (flags & 0x80) p += 3 * 2 ** ((flags & 7) + 1)
        p++ // LZW minimum code size
        skip()
      } else return
    }
  } catch { return }
  // no trailer or no image descriptor is not a picture whose work can be bounded
  if (!trailer || frames < 1) return
  return { width, height, frames }
}

/** a JPEG's size sits in the frame header that comes before its scan data */
function jpegWorkload(b: Buffer): RasterWorkload | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return
  let p = 2
  let frame: { width: number; height: number } | undefined
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return
    let marker = b[p + 1]
    while (marker === 0xff && p + 2 < b.length) { p++; marker = b[p + 1] }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue }
    const length = b.readUInt16BE(p + 2)
    if (length < 2) return
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // the segment has to cover its own precision, height, width, component count and its components
      if (frame || length < 8 || p + 10 > b.length || p + 2 + length > b.length) return
      if (length < 8 + 3 * b[p + 9]) return
      frame = { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) }
    } else if (marker === 0xda) {
      // a scan follows its own header, and the file has to carry it to the end marker
      if (!frame || length < 6 || p + 2 + length > b.length) return
      for (let q = p + 2 + length; q + 1 < b.length; q++) if (b[q] === 0xff && b[q + 1] === 0xd9) return { ...frame, frames: 1 }
      return
    } else if (marker === 0xd9) return // an end before any scan is not an image
    p += 2 + length
  }
}

function webpWorkload(b: Buffer): RasterWorkload | undefined {
  if (b.length < 20 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return
  // the RIFF header says how much file there is: a length that does not match it is not a WebP at all
  const riff = 8 + b.readUInt32LE(4)
  if (riff > b.length || riff < 12) return
  let width = 0
  let height = 0
  let pictureWidth = 0
  let pictureHeight = 0
  let animated = false
  let canvas = false
  let picture = false
  for (let p = 12; p + 8 <= riff; ) {
    const type = b.toString('ascii', p, p + 4)
    const size = b.readUInt32LE(p + 4)
    const data = p + 8
    if (size > riff || data + size > riff) return
    // each field is read only inside the chunk's own declared size
    if (type === 'VP8X') {
      if (size < 10) return
      canvas = true
      width = 1 + b.readUIntLE(data + 4, 3)
      height = 1 + b.readUIntLE(data + 7, 3)
      animated ||= !!(b[data] & 0x02)
    } else if (type === 'ANIM') {
      if (size < 6) return
      animated = true
    } else if (type === 'ANMF') {
      if (size < 16) return
      animated = true
      picture = true
    } else if (type === 'VP8 ' && size >= 10) {
      // an extended still image (VP8X, maybe ALPH) carries its pixels in VP8 or VP8L, not in the canvas chunk
      if (picture || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return
      pictureWidth = b.readUInt16LE(data + 6) & 0x3fff
      pictureHeight = b.readUInt16LE(data + 8) & 0x3fff
      if (!canvas) {
        width = pictureWidth
        height = pictureHeight
      }
      picture = true
    } else if (type === 'VP8L' && size >= 5) {
      // one picture per file: a second, smaller one must not hide the first
      if (picture || b[data] !== 0x2f) return
      const bits = b.readUInt32LE(data + 1)
      pictureWidth = 1 + (bits & 0x3fff)
      pictureHeight = 1 + ((bits >>> 14) & 0x3fff)
      if (!canvas) {
        width = pictureWidth
        height = pictureHeight
      }
      picture = true
    }
    p = data + size + (size & 1)
    if (p > riff) return // an odd-sized chunk carries a padding byte
  }
  // a canvas with nothing to draw in it is not a picture whose work can be bounded, and a payload that claims more
  // pixels than the canvas it sits on contradicts itself
  if (!picture || !width || !height) return
  if (pictureWidth > width || pictureHeight > height) return
  return { width, height, frames: animated ? 2 : 1 }
}

/** the decoded work a raster asks for, or undefined when its own headers don't say (never trusted as small) */
export function rasterWorkload(path: string, b: Buffer): RasterWorkload | undefined {
  const workload = /\.png$/i.test(path) ? pngWorkload(b) : /\.jpe?g$/i.test(path) ? jpegWorkload(b) : /\.gif$/i.test(path) ? gifWorkload(b) : /\.webp$/i.test(path) ? webpWorkload(b) : undefined
  return workload && workload.width > 0 && workload.height > 0 && Number.isSafeInteger(workload.width * workload.height) ? workload : undefined
}

/** Linux descriptor-relative walking: every component is opened without following links. Fail closed elsewhere. */
function readApprovedBytes(path: string, roots: readonly string[], limit: number): Buffer {
  if (process.platform !== 'linux') throw new Error('Document preview currently requires Linux.')
  if (!isAbsolute(path) || path.length > 4096 || path.includes('\0') || path.includes('\\')) throw new Error('Document unavailable.')
  if (path.split('/').slice(1).some((p) => !p || p.startsWith('.'))) throw new Error('Document unavailable.')
  const approved = roots.find((root) => isAbsolute(root) && inside(root, path))
  if (!approved) throw new Error('Document unavailable.')
  const descriptors: number[] = []
  try {
    const root = realpathSync(approved)
    // A changed root symlink must not silently grant access to another directory.
    if (root !== approved) throw new Error('Document unavailable.')
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    descriptors.push(fd)
    const parts = relative(root, path).split(sep)
    for (let i = 0; i < parts.length; i++) {
      fd = openSync(`/proc/self/fd/${fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (i < parts.length - 1 ? constants.O_DIRECTORY : 0))
      descriptors.push(fd)
    }
    const stat = fstatSync(fd)
    if (!inside(root, realpathSync(`/proc/self/fd/${fd}`)) || !stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Document unavailable.')
    // Bounded even if the file grows during the read. Do not stream a growing file indefinitely.
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null)
      if (!n) break
      length += n
    }
    if (length > limit) throw new Error('Document unavailable.')
    return bytes.subarray(0, length)
  } catch {
    throw new Error('Document unavailable. It may be missing, outside the approved directory, linked, or too large.')
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd)
  }
}

export function readDocument(path: string, roots: readonly string[]): { path: string; text: string } | { path: string; image: string; mime: string } {
  const image = IMAGE_EXT.test(path)
  if (!image && !TEXT_EXT.test(path)) throw new Error('Document unavailable.')
  const content = readApprovedBytes(path, roots, image ? IMAGE_MAX_BYTES : MARKDOWN_MAX_BYTES)
  if (image) {
    const mime = imageMime(path, content)
    if (!mime) throw new Error('Document unavailable.')
    const workload = rasterWorkload(path, content)
    if (!workload) throw new Error('Document unavailable. The image header could not be read.')
    if (workload.frames > 1) throw new Error('Animated images are not previewed; save a single frame.')
    if (workload.width > RASTER_MAX_SIDE || workload.height > RASTER_MAX_SIDE || workload.width * workload.height > RASTER_MAX_PIXELS)
      throw new Error('This image is too large to preview.')
    return { path, image: content.toString('base64'), mime }
  }
  if (content.includes(0)) throw new Error('Document unavailable.')
  try { return { path, text: new TextDecoder('utf-8', { fatal: true }).decode(content) } }
  catch { throw new Error('Document unavailable.') }
}

// Compatibility for the original Markdown-only reader's callers.
export const readMarkdown = readDocument

/** Deliberately no default roots. Configuration lives outside the application checkout. */
export function markdownRoots(): string[] {
  try {
    const config: unknown = JSON.parse(readFileSync(join(HOME, 'markdown-preview.json'), 'utf8'))
    const roots = (config as { roots?: unknown })?.roots
    return Array.isArray(roots) && roots.every((p) => typeof p === 'string') ? roots : []
  } catch {
    return []
  }
}

export function markdownResponse(req: Request, roots = markdownRoots()): Response {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }
  // Custom header prevents cross-origin passive reads. Existing app sameSite checks still apply.
  if (req.headers.get('x-shepherdr') !== '1') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers })
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...headers, allow: 'GET' } })
  try {
    return new Response(JSON.stringify(readDocument(new URL(req.url).searchParams.get('path') ?? '', roots)), { headers })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 404, headers })
  }
}
