// Case-level quarantine: exact (file, test name) pairs from test/quarantine.json are skipped in blocking CI, with
// their reason printed, so a red baseline does not hide a newly broken maintained case. Unset (local, fine-grained
// runs, the diagnostic workflow) nothing is skipped at all. A manifest entry that no longer matches a test in its
// file fails that file's run, so a stale entry cannot silently widen or narrow the quarantine.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.SHEPHERDR_QUARANTINE
if (mode !== 'off' && (mode === 'block' || mode === 'check')) {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, 'quarantine.json'), 'utf8')) as {
    cases: { file: string; name: string; disposition: string; why: string }[]
  }
  const at = Bun.main.lastIndexOf('/test/')
  const here = at >= 0 ? Bun.main.slice(at + 1) : Bun.main
  const mine = manifest.cases.filter((c) => c.file === here)
  const hit = new Set<string>()
  const stack: string[] = []
  const g = globalThis as unknown as Record<string, unknown>
  const realDescribe = g.describe as ((name: string, fn: () => void) => void) | undefined
  const realTest = g.test as ((name: string, fn: unknown, timeout?: number) => unknown) | undefined
  if (realDescribe && realTest) {
    const describe = (name: string, fn: () => void) => {
      stack.push(name)
      try { realDescribe(name, fn) } finally { stack.pop() }
    }
    const make = (base: typeof realTest) => (name: string, fn: unknown, timeout?: number) => {
      const full = [...stack, name].join(' > ')
      const q = mine.find((c) => c.name === full)
      if (!q) return base(name, fn, timeout)
      hit.add(full)
      console.log(`QUARANTINED (${q.disposition}): ${full} — ${q.why}`)
      return (base as unknown as { skip: typeof base }).skip(name, fn, timeout)
    }
    const test = Object.assign(make(realTest), realTest) as typeof realTest
    g.describe = describe
    g.test = test
    if (mode === 'check') {
      const missing = mine.filter((c) => !hit.has(c.name))
      if (missing.length) throw new Error(`quarantine.json lists cases this file no longer has: ${missing.map((c) => c.name).join(' | ')}`)
    }
  } else {
    console.log('QUARANTINE: bun\'s describe/test globals were not available; nothing skipped')
  }
}
