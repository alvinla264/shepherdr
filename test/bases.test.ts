// Which branch a task starts from and merges into: its space's, captured when it is added, or a branch of its own.
import { describe, expect, test } from 'bun:test'
import { placeId, repo, sh, started, until, world, writeJson } from './engine-world.ts'

/** a fresh world with nothing from earlier tests, its machine's room set */
function fresh(limits: Record<string, string> = {}) {
  const w = world()
  w.engine.tasks.splice(0)
  for (const k of ['machine.maxTasks', 'machine.startLoad', 'machine.startMemory']) w.settings.set(k, null)
  for (const [k, v] of Object.entries(limits)) expect(w.settings.set(k, v).ok).toBe(true)
  return w
}

describe('a task keeps the target it was given', () => {
  test('a space’s new base reaches new tasks only: one at work and one waiting keep theirs, a task may pick its own', async () => {
    const w = fresh({ 'machine.maxTasks': '1' })
    const dir = repo()
    sh('git branch develop && git branch feature/topic', dir)
    const a = await started(w, dir, 'base-at-work')
    w.brief(a.key)
    const b = w.engine.add({ project: a.p.name, title: 'Waiting', by: 'test' })
    expect(b.base).toBe('main')
    // the space moves on; nothing already added moves with it
    await w.places.setBase(a.p.name, 'develop')
    expect(a.t.base).toBe('main')
    expect(b.base).toBe('main')
    const c = w.engine.add({ project: a.p.name, title: 'New default', by: 'test' })
    const d = w.engine.add({ project: a.p.name, title: 'Its own choice', base: 'feature/topic', by: 'test' })
    expect(c.base).toBe('develop')
    expect(d.base).toBe('feature/topic')
    // a branch that isn't there, or isn't a branch name, leaves the target it had
    await expect(w.places.setBase(a.p.name, 'missing')).rejects.toThrow('No local branch missing')
    await expect(w.places.setBase(a.p.name, '--all')).rejects.toThrow('Choose a branch name')
    expect(a.p.base).toBe('develop')
    expect(sh('git branch --show-current', dir)).toBe('main')
    // the one that waited starts on its own target, not the space's new one
    w.agentIs(a.key, 'idle')
    await until(() => w.started.some((s) => s.key === `${b.id}/Agent`))
    expect(w.started.find((s) => s.key === `${b.id}/Agent`)!.system).toContain('(from main)')
  })
  test('a task saved before targets were kept takes the space’s at load, and a later change leaves it where it was', async () => {
    const first = fresh()
    const dir = repo()
    sh('git branch develop', dir)
    const p = await first.places.add(dir, 'base-legacy')
    first.engine.tasks.splice(0)
    // an older queued record: no base of its own, waiting on a task that is gone
    writeJson('tasks.json', {
      next: { [p.key]: 1 },
      tasks: [{ id: `${p.key}-1`, n: 1, project: placeId.space(p.name), title: 'Old queued', desc: '', by: 'test', created: Date.now(), updated: Date.now(), told: 'queued', after: ['GONE-1'] }],
    })
    const loaded = world()
    expect(loaded.engine.task(`${p.key}-1`)!.base).toBe('main')
    await loaded.places.setBase(p.name, 'develop')
    // a second start finds the record frozen on main, and the space on develop
    const again = world()
    expect(again.engine.task(`${p.key}-1`)!.base).toBe('main')
    expect(again.places.byName(p.name)!.base).toBe('develop')
  })
})
