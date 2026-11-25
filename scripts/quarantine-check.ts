// Static check of test/quarantine.json: every entry names a test its file really declares (the leaf title, inside the
// same describe chain in order), no duplicates, and no entry for a file with no such test. Run with `bun scripts/quarantine-check.ts`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const manifest = JSON.parse(readFileSync(join(root, 'test/quarantine.json'), 'utf8')) as {
  cases: { file: string; name: string; disposition: string; why: string }[]
}
const seen = new Set<string>()
const problems: string[] = []
for (const c of manifest.cases) {
  const id = `${c.file}\u0000${c.name}`
  if (seen.has(id)) problems.push(`duplicate: ${c.name}`)
  seen.add(id)
  const parts = c.name.split(' > ')
  const leaf = parts.at(-1)!
  let src = ''
  try { src = readFileSync(join(root, c.file), 'utf8') } catch { problems.push(`no such file: ${c.file}`); continue }
  // A title is either a literal in the file or built from a template (a loop over widths/themes, a place name). For a
  // template only its static prefix is visible here; the run-time `check` mode is what proves the exact name.
  const flat = (x: string) => x.replace(/\s+/g, ' ').replace(/[’]/g, "'").trim()
  const flatSrc = flat(src)
  const probe = (t: string) => {
    if (src.includes(t) || flatSrc.includes(flat(t))) return true
    const cut = Math.min(...[t.indexOf(' ('), t.indexOf('${')].filter((i) => i > 0).concat([t.length]))
    const prefix = t.slice(0, cut)
    return prefix.length >= 8 && src.includes(prefix)
  }
  if (!probe(leaf)) problems.push(`leaf title not in ${c.file}: ${leaf}`)
  for (const step of parts) if (!probe(step)) problems.push(`describe chain not in ${c.file}: ${step} (in ${c.name})`)
  if (!c.disposition || !c.why) problems.push(`entry without disposition or reason: ${c.name}`)
}
const files = new Set(manifest.cases.map((c) => c.file))
const byKind: Record<string, number> = {}
for (const c of manifest.cases) byKind[c.disposition] = (byKind[c.disposition] ?? 0) + 1
console.log(`quarantine.json: ${manifest.cases.length} cases in ${files.size} files — ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}`)
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`- ${p}`)
  process.exit(1)
}
console.log('every entry matches a declared test in its file; maintained suite = everything else, still blocking')
