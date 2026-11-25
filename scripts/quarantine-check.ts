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
  if (!src.includes(leaf)) problems.push(`leaf title not in ${c.file}: ${leaf}`)
  let from = 0
  for (const step of parts) {
    const at = src.indexOf(step, from)
    if (at < 0) { problems.push(`describe chain not in order in ${c.file}: ${step} (in ${c.name})`); break }
    from = at + step.length
  }
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
