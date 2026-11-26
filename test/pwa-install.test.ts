// Adding Shepherdr to the home screen through a login gate (Authelia, Cloudflare Access): the browser fetches the
// manifest without the login cookie unless the link asks for credentials, and the gate then answers with its sign-in
// page, so the install fails. The service worker registers beside the page, so it is found under any base path
// (/shepherdr/) too. The manifest and the worker are this app's own files, same-origin (GitHub #494).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')

/** the page's `<link>` with this rel, as written */
function headLink(rel: string) {
  return (html.match(/<link\b[^>]*>/gi) ?? []).find((l) => new RegExp(`\\brel=["']${rel}["']`, 'i').test(l))
}

describe('home-screen install behind a login gate', () => {
  test('the manifest link asks for credentials', () => {
    const manifest = headLink('manifest')
    expect(manifest).toBeDefined()
    // relative: it is fetched beside the page, so a base path (/shepherdr/) keeps it same-origin
    expect(manifest).toContain('href="manifest.webmanifest"')
    // the login cookie: without it the gate answers the manifest fetch with its sign-in page
    expect(manifest).toMatch(/\bcrossorigin=["']use-credentials["']/i)
  })

  test('the manifest is the app’s own, which the server serves as a manifest', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8')) as {
      name?: string
      start_url?: string
      scope?: string
      icons?: { src?: string }[]
    }
    expect(manifest.name).toBe('Shepherdr')
    // relative: under a base path the installed app opens and scopes beside the page
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
    for (const icon of manifest.icons ?? []) expect(icon.src?.startsWith('/')).toBe(false)
  })

  test('the service worker registers beside the page, never from the site root', () => {
    const client = readFileSync(join(root, 'plugins', 'alerts', 'client.tsx'), 'utf8')
    const registrations = [...client.matchAll(/serviceWorker[\s\S]{0,40}?\.register\(\s*([^)]+?)\s*\)/g)].map((m) => m[1])
    expect(registrations.length).toBeGreaterThan(0)
    for (const target of registrations) {
      // a literal relative path of the worker itself: '/sw.js' escapes a base path and a variable could be anything;
      // './sw.js' is the same file, so it counts
      expect(target).toMatch(/^['"]\.?[^'"/][^'"]*['"]$/)
      expect(target.slice(1, -1).replace(/^\.\//, '')).toBe('sw.js')
    }
  })
})
