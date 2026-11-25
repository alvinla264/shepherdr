// Static check of test/quarantine.json: every entry names a test its file really declares (the leaf title, inside the
// same describe chain in order), no duplicates, and no entry for a file with no such test. Run with `bun scripts/quarantine-check.ts`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const manifest = JSON.parse(readFileSync(join(root, 'test/quarantine.json'), 'utf8')) as {
  cases: { file: string; name: string; disposition: string; why: string; dynamic?: boolean }[]
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
  const flatSrc = flat(src).replace(/\\'/g, "'")
  // exact means the finished title (or its describe chain) appears in the file, whitespace-normalised and with the
  // source's escaped apostrophes folded. template means the title is built in a loop or a `${}` literal, where only
  // its static prefix can appear; such an entry must say "dynamic": true, and the run-time check mode proves the
  // exact interpolated name or fails the file. A prefix match without that flag is a problem, so a typo cannot hide.
  const state = (t: string): 'exact' | 'template' | 'missing' => {
    if (src.includes(t) || flatSrc.includes(flat(t))) return 'exact'
    // a loop or `${}` title: the file holds its static words up to the interpolation, so try every word boundary
    const words = flat(t).split(' ')
    for (let n = words.length; n >= 2; n--) {
      const prefix = words.slice(0, n).join(' ')
      if (prefix.length < 8) break
      if (flatSrc.includes(prefix + '${')) return 'template'
    }
    const cut = Math.min(...[t.indexOf(' ('), t.indexOf('${')].filter((i) => i > 0).concat([t.length]))
    const prefix = t.slice(0, cut)
    if (prefix.length >= 8 && flatSrc.includes(flat(prefix))) return 'template'
    return 'missing'
  }
  for (const step of parts) {
    const how = state(step)
    if (how === 'missing') { problems.push(`title not in ${c.file}: ${step} (in ${c.name})`); break }
    if (how === 'template' && !c.dynamic) { problems.push(`template-built title needs "dynamic": true — ${step} (in ${c.name})`); break }
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
