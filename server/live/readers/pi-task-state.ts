// Protocol v1. Canonical copy: the companion Pi extension, outside this repository.
// Shepherdr carries a byte-identical reader copy. No commands, logs or credentials are published.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PI_JOBS_FRESH_MS = 30_000;
export const PI_JOBS_WAIT_MS = 30 * 60_000;
export const piJobsDir = () => join(homedir(), '.local/state/shepherdr-pi-jobs');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const piJobsFile = (dir: string, socket: string, pane: string) => join(dir, `${hash(`${socket}\0${pane}`)}.json`);
const processStart = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19];
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const privateStat = (s: Stats) => s.uid === process.getuid?.() && (s.mode & 0o077) === 0;

export interface PiJobCounts {
  phase: 'active' | 'idle';
  running: number;
  autoWake: number;
  completionPending: number;
  oldestStartedAt: number;
}
export interface PiJobState extends PiJobCounts {
  version: 1;
  paneId: string;
  socketHash: string;
  sessionId: string;
  sessionPathHash?: string;
  pid: number;
  processStart: string;
  bootId: string;
  instance: string;
  revision: number;
  updatedAt: number;
  changedAt: number;
}
export const piJobToken = (s: PiJobState) => `${s.instance}:${s.revision}`;
export const piJobWaiting = (s: PiJobCounts) => s.phase === 'idle' && (s.autoWake > 0 || s.completionPending > 0);
export function piJobLine(s: PiJobState): string {
  if (s.phase === 'active') return `Pi working · ${s.running} background job(s)`;
  if (s.completionPending) return `Pi completion pending · ${s.completionPending} notification(s)`;
  if (s.autoWake) return `Waiting on ${s.autoWake} background job(s) · automatic wake expected`;
  if (s.running) return `${s.running} background job(s) · automatic wake disabled`;
  return 'Pi idle · no pending background work';
}

/** Local Linux state only. Unknown, stale, insecure, or mismatched state never suppresses supervision. */
export function readPiJobState(target: { socket: string; pane: string; sessionId?: string; sessionPath?: string }, now = Date.now(), dir = piJobsDir()): PiJobState | undefined {
  let fd: number | undefined;
  try {
    if (process.platform !== 'linux' || (!target.sessionId && !target.sessionPath)) return;
    const d = lstatSync(dir);
    if (!d.isDirectory() || !privateStat(d)) return;
    fd = openSync(piJobsFile(dir, target.socket, target.pane), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const f = fstatSync(fd);
    if (!f.isFile() || !privateStat(f) || f.nlink !== 1 || f.size > 16_384) return;
    const s = JSON.parse(readFileSync(fd, 'utf8')) as PiJobState;
    if (s.version !== 1 || s.paneId !== target.pane || s.socketHash !== hash(target.socket)) return;
    if (target.sessionPath ? s.sessionPathHash !== hash(target.sessionPath) : s.sessionId !== target.sessionId) return;
    if (s.phase !== 'active' && s.phase !== 'idle') return;
    for (const n of [s.running, s.autoWake, s.completionPending, s.oldestStartedAt, s.revision, s.updatedAt, s.changedAt, s.pid])
      if (!Number.isSafeInteger(n) || n < 0) return;
    if (!s.pid || s.autoWake > s.running || (s.autoWake > 0 && (!s.oldestStartedAt || s.oldestStartedAt > now))) return;
    if (typeof s.instance !== 'string' || !/^[0-9a-f-]{36}$/.test(s.instance) || typeof s.processStart !== 'string') return;
    if (now - s.updatedAt > PI_JOBS_FRESH_MS || s.updatedAt > now + 5000 || s.changedAt > s.updatedAt) return;
    if (s.bootId !== bootId() || s.processStart !== processStart(s.pid)) return;
    return s;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Owns one session's lease. Heartbeats renew freshness without changing the activity token. */
export class PiJobStateWriter {
  private state?: PiJobState;
  private timer?: ReturnType<typeof setInterval>;
  private file?: string;
  constructor(private dir = piJobsDir()) {}

  start(target: { socket: string; pane: string; sessionId: string; sessionPath?: string }, counts: () => PiJobCounts) {
    this.stop();
    try {
      if (process.platform !== 'linux') return;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const d = lstatSync(this.dir);
      if (!d.isDirectory() || !privateStat(d)) return;
      this.file = piJobsFile(this.dir, target.socket, target.pane);
      const now = Date.now();
      this.state = { ...counts(), version: 1, paneId: target.pane, socketHash: hash(target.socket), sessionId: target.sessionId,
        sessionPathHash: target.sessionPath ? hash(target.sessionPath) : undefined,
        pid: process.pid, processStart: processStart(process.pid), bootId: bootId(), instance: randomUUID(), revision: 1, updatedAt: now, changedAt: now };
      this.write(true);
      this.timer = setInterval(() => this.update(counts(), false), 5000);
      this.timer.unref?.();
    } catch { this.stop(); }
  }

  update(counts: PiJobCounts, activity = true) {
    const s = this.state;
    if (!s) return;
    const changed = (Object.keys(counts) as (keyof PiJobCounts)[]).some((k) => s[k] !== counts[k]);
    if (activity || changed) { s.revision++; s.changedAt = Date.now(); }
    Object.assign(s, counts);
    this.write();
  }

  accepts(token: string, counts: PiJobCounts, busy: boolean): boolean {
    return !!this.state && token === piJobToken(this.state) && !busy && counts.phase === 'idle' && !piJobWaiting(counts);
  }

  private write(takeover = false) {
    if (!this.state || !this.file) return;
    // A superseded process must not renew over the replacement session's lease.
    if (!takeover) {
      try {
        if (JSON.parse(readFileSync(this.file, 'utf8')).instance !== this.state.instance) { this.stop(); return; }
      } catch { this.stop(); return; }
    }
    const tmp = `${this.file}.${this.state.instance}.tmp`;
    try {
      this.state.updatedAt = Date.now();
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.file);
    } catch { try { unlinkSync(tmp); } catch {} }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A second session in the same pane may have replaced this lease already.
    try {
      if (this.file && this.state && JSON.parse(readFileSync(this.file, 'utf8')).instance === this.state.instance) unlinkSync(this.file);
    } catch {}
    this.state = undefined;
    this.file = undefined;
  }
}
