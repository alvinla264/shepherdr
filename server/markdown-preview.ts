// Local-only Markdown/HTML reader. HTML is returned as JSON text, never as a navigable HTML response.
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { HOME } from './store.ts'

export const MARKDOWN_MAX_BYTES = 512 * 1024
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
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
