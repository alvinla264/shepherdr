// Exact case-level quarantine, declared at the test itself with bun's native `test.skipIf`:
//   test.skipIf(q('test/x.test.ts', 'a case'))('a case', async () => { ... })
// `q` answers whether this file's exact full name is listed in test/quarantine.json, so nothing is wrapped, no global is
// patched and bun's signatures are untouched. Unset (default developer suite and the manual diagnostic) nothing skips.
// SHEPHERDR_QUARANTINE=block or check skips the listed cases and prints their disposition and reason.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Entry = { file: string; name: string; disposition: string; why: string }
let cases: Entry[] = []
try { cases = (JSON.parse(readFileSync(join(import.meta.dir, 'quarantine.json'), 'utf8')) as { cases: Entry[] }).cases } catch (e) { throw new Error(`test/quarantine.json could not be read: ${(e as Error).message}`) }
const pairs = new Set<string>()
for (const c of cases) {
  const id = `${c.file}\u0000${c.name}`
  if (pairs.has(id)) throw new Error(`test/quarantine.json lists ${c.name} twice for ${c.file}`)
  pairs.add(id)
}
const mode = process.env.SHEPHERDR_QUARANTINE ?? 'off'
const on = mode === 'block' || mode === 'check'
const seen = new Set<string>()

export function q(where: string, name: string): boolean {
  // A declaration knows its own title but not the `describe` chain bun prefixes, so match the full name when given and
  // otherwise that file's entry whose full name ends in " > " + the declared title. Two such entries would be
  // ambiguous and fail, which keeps the match exact rather than picking one silently.
  const exact = cases.filter((c) => c.file === where && c.name === name)
  const byLeaf = cases.filter((c) => c.file === where && c.name.endsWith(` > ${name}`))
  const found = exact.length ? exact : byLeaf
  if (found.length > 1) throw new Error(`quarantine.json has ${found.length} entries for "${name}" in ${where}; name one exactly`)
  const entry = found[0]
  if (!entry) return false
  const id = `${where}\u0000${entry.name}`
  if (seen.has(id)) throw new Error(`q() was called twice for ${entry.name} in ${where}; a declaration would be skipped twice`)
  seen.add(id)
  if (!on) return false
  console.log(`QUARANTINED (${entry.disposition}): ${name} — ${entry.why}`)
  return true
}
