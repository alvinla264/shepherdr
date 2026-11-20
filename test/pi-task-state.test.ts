// Authored locally; run only on an authorized test host (AGENTS.md).
import { describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiJobStateWriter, PI_JOBS_FRESH_MS, piJobToken, piJobWaiting, piJobsFile, readPiJobState, type PiJobCounts, type PiJobState } from '../server/live/readers/pi-task-state.ts'

const idle: PiJobCounts = { phase: 'idle', running: 0, autoWake: 0, completionPending: 0, oldestStartedAt: 0 }
const target = { socket: '/private/herdr.sock', pane: 'pane-1', sessionId: 'session-1', sessionPath: '/sessions/session-1.jsonl' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-pi-jobs-'))
  chmodSync(dir, 0o700)
  const writer = new PiJobStateWriter(dir)
  let counts = { ...idle }
  writer.start(target, () => counts)
  const file = piJobsFile(dir, target.socket, target.pane)
  const read = (now = Date.now()) => readPiJobState(target, now, dir)
  const update = (patch: Partial<PiJobCounts>, activity = true) => { counts = { ...counts, ...patch }; writer.update(counts, activity) }
  const mutate = (patch: Partial<PiJobState>) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }), { mode: 0o600 })
  return { dir, writer, file, read, update, mutate, stop: () => { writer.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

describe.skipIf(process.platform !== 'linux')('Pi job state protocol', () => {
  test('two auto-waking jobs, completion handoff, active turn, and final idle are distinct', () => {
    const f = fixture()
    try {
      expect(piJobWaiting(f.read()!)).toBe(false)
      f.update({ running: 2, autoWake: 2, oldestStartedAt: Date.now() })
      expect(piJobWaiting(f.read()!)).toBe(true)
      f.update({ running: 1, autoWake: 1, completionPending: 1 })
      expect(f.read()).toMatchObject({ running: 1, autoWake: 1, completionPending: 1 })
      f.update({ phase: 'active', completionPending: 0 })
      expect(piJobWaiting(f.read()!)).toBe(false)
      f.update({ ...idle })
      expect(f.read()).toMatchObject(idle)
    } finally { f.stop() }
  })

  test('disabled/claimed notifications never promise an automatic wake', () => {
    const f = fixture()
    try {
      f.update({ running: 2 })
      expect(piJobWaiting(f.read()!)).toBe(false)
      f.update({ completionPending: 1 })
      expect(piJobWaiting(f.read()!)).toBe(true)
      f.update({ completionPending: 0 })
      expect(piJobWaiting(f.read()!)).toBe(false)
    } finally { f.stop() }
  })

  test('lease heartbeat preserves a token; actual activity changes it; receiver rejects stale or busy nudges', () => {
    const f = fixture()
    try {
      const token = piJobToken(f.read()!)
      f.update({}, false)
      expect(piJobToken(f.read()!)).toBe(token)
      expect(f.writer.accepts(token, idle, false)).toBe(true)
      expect(f.writer.accepts(token, idle, true)).toBe(false)
      expect(f.writer.accepts(token, { ...idle, completionPending: 1 }, false)).toBe(false)
      f.update({ phase: 'active' })
      f.update({ phase: 'idle' }) // woke and stopped again before the nudge arrived
      expect(f.writer.accepts(token, idle, false)).toBe(false)
    } finally { f.stop() }
  })

  test('exact session and pane match, not a shared cwd or a reused pane', () => {
    const f = fixture()
    try {
      expect(readPiJobState({ ...target, sessionPath: '/other.jsonl' }, Date.now(), f.dir)).toBeUndefined()
      expect(readPiJobState({ ...target, sessionPath: undefined, sessionId: 'other' }, Date.now(), f.dir)).toBeUndefined()
      expect(readPiJobState({ ...target, pane: 'other' }, Date.now(), f.dir)).toBeUndefined()
      expect(readPiJobState({ ...target, socket: '/other.sock' }, Date.now(), f.dir)).toBeUndefined()
      expect(readPiJobState({ socket: target.socket, pane: target.pane }, Date.now(), f.dir)).toBeUndefined()
    } finally { f.stop() }
  })

  test('stale, future, malformed, impossible counts, dead/reused pid and old boot records are unknown', () => {
    const f = fixture()
    try {
      const valid = JSON.parse(readFileSync(f.file, 'utf8'))
      expect(f.read(valid.updatedAt + PI_JOBS_FRESH_MS + 1)).toBeUndefined()
      for (const patch of [{ updatedAt: Date.now() + 60_000 }, { autoWake: 10 }, { running: -1 }, { revision: null }, { pid: 0 }, { pid: 2147483647 }, { processStart: 'wrong' }, { bootId: 'old boot' }]) {
        writeFileSync(f.file, JSON.stringify({ ...valid, ...patch }))
        expect(f.read()).toBeUndefined()
      }
      writeFileSync(f.file, '{')
      expect(f.read()).toBeUndefined()
      writeFileSync(f.file, 'x'.repeat(20_000))
      expect(f.read()).toBeUndefined()
    } finally { f.stop() }
  })

  test('insecure files/directories, symlinks and hardlinks fail closed', () => {
    const f = fixture()
    try {
      chmodSync(f.file, 0o644)
      expect(f.read()).toBeUndefined()
      chmodSync(f.file, 0o600)
      chmodSync(f.dir, 0o755)
      expect(f.read()).toBeUndefined()
      chmodSync(f.dir, 0o700)
      const saved = f.file + '.saved'
      linkSync(f.file, saved)
      expect(f.read()).toBeUndefined()
      unlinkSync(f.file)
      symlinkSync(saved, f.file)
      expect(f.read()).toBeUndefined()
    } finally { f.stop() }
  })

  test('a previous owner cannot remove a new session lease during shutdown', () => {
    const f = fixture()
    const next = new PiJobStateWriter(f.dir)
    try {
      next.start({ ...target, sessionId: 'session-2', sessionPath: '/sessions/session-2.jsonl' }, () => idle)
      f.update({ running: 9 }) // an old heartbeat must not overwrite its replacement
      f.writer.stop()
      expect(readPiJobState({ ...target, sessionId: 'session-2', sessionPath: '/sessions/session-2.jsonl' }, Date.now(), f.dir)).toBeDefined()
    } finally { next.stop(); f.stop() }
  })
})
