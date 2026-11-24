// Picks the reader for a CLI, and tails a log file: each read() returns the events of the lines written since the
// last one.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { ClaudeReader } from './claude.ts'
import { CodexReader } from './codex.ts'
import { PiReader } from './pi.ts'
import { LOG_FINDERS } from './find.ts'
import type { LogEvent, Reader } from './types.ts'

export { ClaudeReader, CodexReader, PiReader }

const READERS: Record<string, () => Reader> = {
  claude: () => new ClaudeReader(),
  codex: () => new CodexReader(),
  pi: () => new PiReader(),
}

/** Kinds with both runtime log discovery and a transcript reader. */
export const CHAT_KINDS = Object.keys(READERS).filter((kind) => !!LOG_FINDERS[kind])

export function chatProblem(kind: string): string | undefined {
  if (!CHAT_KINDS.includes(kind)) return `${kind} does not support Shepherdr chat: no chat log reader is available. Choose ${CHAT_KINDS.join(', ')}. Headless review support is separate.`
}

/** a fresh reader for herdr's agent kind (readers remember open questions and split replies per file) */
export function readerFor(cli: string): Reader | undefined {
  const kind = cli.toLowerCase()
  const key = kind === 'claude-code' || kind === 'claudecode' ? 'claude' : kind
  return Object.hasOwn(READERS, key) ? READERS[key]() : undefined
}

// read big files a piece at a time; Claude Code logs reach tens of MB
const CHUNK = 4 << 20

export class LogTail {
  /** byte offset of the first line not read yet */
  private offset = 0
  /** byte offset of what is read so far: from offset on, the start of a line not ended yet, kept in carry */
  private pos = 0
  private carry: Buffer[] = []
  /** the file's inode: a new one means the file was replaced */
  private ino = -1
  /** the last read stopped at its limit, short of the file's end */
  private more = false

  constructor(
    readonly file: string,
    readonly reader: Reader,
  ) {}

  /** how much of the file is read so far, in bytes */
  get done(): number {
    return this.pos
  }

  /** more is written than read so far: a read with a limit stopped short */
  get behind(): boolean {
    return this.more
  }

  /** a small sum over the 64 bytes before the read position: if they changed, the file was rewritten under the read */
  private seal = -1
  /** it started over at a file that was replaced or rewritten: what it returns is that file from its first line */
  private restarted = false
  takeRestarted(): boolean {
    const r = this.restarted
    this.restarted = false
    return r
  }
  private stampSeal(fd: number): void {
    if (this.pos < 64) {
      this.seal = -1
      return
    }
    const buf = Buffer.alloc(64)
    const got = readSync(fd, buf, 0, 64, this.pos - 64)
    let h = 0
    for (let i = 0; i < got; i++) h = (h * 31 + buf[i]!) | 0
    this.seal = h
  }

  /** how far it has read, and which file: compared with the file now, they say whether what it read is that file's end */
  get position(): number {
    return this.pos
  }

  get readIno(): number {
    return this.ino
  }

  /** nothing is known about this file's end: it could not be opened or measured, or it ends in half a line */
  private failed = false
  get atEnd(): boolean {
    return !this.more && !this.failed && this.carry.length === 0
  }

  /** events of the complete lines written since the last read, or of about `max` bytes more of the file (a line it
   *  ends in the middle of is kept, and comes whole from a later read); starts over when the file shrank or was
   *  replaced */
  read(max = Infinity): LogEvent[] {
    let size: number
    this.more = false
    this.failed = false
    try {
      const st = statSync(this.file)
      if (st.ino !== this.ino || st.size < this.pos) this.restart(st.ino)
      size = st.size
    } catch {
      this.failed = true
      return []
    }
    if (size <= this.pos) return []

    const out: LogEvent[] = []
    let fd: number
    try {
      fd = openSync(this.file, 'r')
    } catch {
      this.failed = true
      return []
    }
    try {
      // the bytes just before where it stands must still be the ones it read: a rewrite that only grows shows here
      if (this.seal !== -1) {
        const buf = Buffer.alloc(64)
        const got = this.pos >= 64 ? readSync(fd, buf, 0, 64, this.pos - 64) : -1
        let h = 0
        for (let i = 0; i < got; i++) h = (h * 31 + buf[i]!) | 0
        if (got !== 64 || h !== this.seal) this.restart(this.ino)
      }
      const began = this.pos
      while (this.pos < size && this.pos - began < max) {
        const buf = Buffer.alloc(Math.min(CHUNK, Math.max(max, 64 << 10), size - this.pos))
        const got = readSync(fd, buf, 0, buf.length, this.pos)
        if (got <= 0) break
        this.pos += got
        const chunk = buf.subarray(0, got)
        // a long line goes on: joined once it ends
        if (chunk.indexOf(10) === -1) {
          this.carry.push(chunk)
          continue
        }
        const data = this.carry.length ? Buffer.concat([...this.carry, chunk]) : chunk
        const start = this.offset
        const lines: { text: string; offset: number }[] = []
        let from = 0
        for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, from)) {
          let text = data.toString('utf8', from, nl)
          if (text.endsWith('\r')) text = text.slice(0, -1)
          if (text.trim()) lines.push({ text, offset: start + from })
          from = nl + 1
        }
        this.carry = from < data.length ? [Buffer.from(data.subarray(from))] : []
        this.offset = start + from
        if (lines.length) out.push(...this.reader.parse(lines, this.file))
      }
      this.more = this.pos < size
      this.stampSeal(fd)
    } finally {
      closeSync(fd)
    }
    return out
  }

  /** every event in the file, from the start (later read() calls go on from the end) */
  readAll(): LogEvent[] {
    this.ino = -1
    return this.read()
  }

  private restart(ino: number) {
    // a tail's first read is not a start-over: it read nothing before that this file could contradict, and saying it was
    // made the chat wipe what it held and read the whole log again from the start, every time it began again on a log
    // that changed while it was read: a watched chat re-read tens of megabytes a second, and the server spun
    if (this.pos > 0) this.restarted = true
    this.offset = 0
    this.pos = 0
    this.carry = []
    this.ino = ino
    this.reader.reset?.(this.file)
  }
}
