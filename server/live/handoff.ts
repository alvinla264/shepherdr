// What a task's next agent is handed when another CLI (or the backup) takes over: the brief as it was given, the
// human's first words (the constraints live there), the note the agent kept current while it worked, the one it wrote
// at the switch when it was still there, and the facts of the branch. Every part is capped by size, not by message
// count, so a whole package stays a few thousand characters (roughly 1.5k tokens); an obvious credential is stripped,
// because the note lands in the chat and the package shows in the card that says what was handed over.
import type { Message } from '../../shared/types.ts'

/** characters one part may take: the sum, with the labels, stays under PACKAGE_MAX */
export const HANDOFF_CAPS = { brief: 1100, human: 800, note: 900, final: 700, commits: 450, changes: 450, diffstat: 450, status: 350 } as const

/** the whole package's ceiling in characters: the caps above leave room for the labels under it */
export const PACKAGE_MAX = 6000

/** the note a task's agent keeps for whoever takes over, and when it wrote it */
export interface HandoffNote {
  text: string
  /** who wrote it, as the chat reads it ("Claude Code") */
  by: string
  at: number
}

/** everything a switch hands over; each part left out when it has nothing to say */
export interface Handoff {
  /** the brief as it was given */
  brief?: string
  /** the human's first messages, verbatim */
  human?: string
  /** the living note, replaced in place at each milestone */
  note?: HandoffNote
  /** the note the outgoing agent wrote when it was asked at the switch */
  final?: string
  commits?: string
  changes?: string
  diffstat?: string
  /** the agent's own status line (shepherdr status) and what it said when it reported ready */
  status?: string
}

/** text cut to `max` characters at a word, marker included, so a reader knows it goes on; cutting it again changes
 *  nothing. One word longer than the room is cut hard: `max` is the ceiling, never a suggestion */
export function cap(text: string, max: number): string {
  const s = text.replace(/\s+$/g, '')
  if (s.length <= max) return s
  const head = s.slice(0, Math.max(1, max - ' … (cut)'.length))
  return `${head.replace(/\s+\S*$/, '') || head} … (cut)`
}

/** a credential's known shape, a named one's value as it is assigned, and a bearer token: a name followed by plain
 *  prose ("do not change token validation") is left alone, and the value after a name is never assumed to be one */
const TOKEN =
  /\b(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,})\b/g
const NAMED =
  /\b(password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]\s*(?!\[redacted\])["']?([^\s"',;]{4,})["']?/gi
const BEARER = /\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/-]{8,}=*/gi

/** an obvious credential taken out of words meant for the chat, and whether one was */
export function redact(text: string): { text: string; stripped: boolean } {
  let stripped = false
  const out = text
    .replace(TOKEN, () => {
      stripped = true
      return '[redacted]'
    })
    .replace(NAMED, (all, name: string) => {
      stripped = true
      return `${name}=[redacted]`
    })
    .replace(BEARER, () => {
      stripped = true
      return 'Bearer [redacted]'
    })
  return { text: out, stripped }
}

/** the human's first messages, verbatim, within the cap: the constraints live there, not in the last twelve */
export function humanFirst(messages: Message[], skip?: string): string {
  const said = messages
    .filter((m) => m.who === 'you' && !!m.text?.trim() && m.text.trim() !== skip)
    .map((m) => m.text!.trim())
  return cap(said.join('\n\n'), HANDOFF_CAPS.human)
}

/** the task's own status facts: what its agent last said of its progress, and what it said when it reported ready */
export function statusFacts(t: { report?: { msg: string; progress: number; left?: number }; said?: string }): string {
  const lines: string[] = []
  if (t.report) {
    const left = t.report.left === undefined ? '' : `, about ${t.report.left} min left`
    lines.push(`Its agent last said: "${t.report.msg}" — ${t.report.progress}% done${left}.`)
  }
  if (t.said) lines.push(`It reported ready: ${t.said}`)
  return lines.join('\n')
}

/** the package in words, labelled so the next agent can tell a fact from a claim; every part is stripped of an
 *  obvious credential, since the same words land in the card the human reads */
export function handoffText(h: Handoff): string {
  const clean = (text: string, max: number) => cap(redact(text.trim()).text, max)
  const sections: string[] = []
  if (h.brief?.trim()) sections.push(`The brief as given:\n\n${clean(h.brief, HANDOFF_CAPS.brief)}`)
  if (h.human?.trim()) sections.push(`The human said:\n\n${clean(h.human, HANDOFF_CAPS.human)}`)
  // the note written at the switch is the living note's latest version, replaced in place: said once, and said so
  const told = redact(h.final?.trim() ?? '').text
  const final = told && told !== h.note?.text.trim() ? told : ''
  const atSwitch = !!told && told === h.note?.text.trim()
  if (h.note?.text.trim())
    sections.push(
      `The task's handoff note (written by ${h.note.by}, ${atSwitch ? 'last at the switch' : 'kept current while it worked'}):\n\n${clean(h.note.text, HANDOFF_CAPS.note)}`,
    )
  if (final) sections.push(`The agent that ran it before you wrote:\n\n${cap(final, HANDOFF_CAPS.final)}`)
  const facts = [
    h.commits === undefined ? '' : `Commits on the branch so far:\n${clean(h.commits || 'none', HANDOFF_CAPS.commits)}`,
    h.changes === undefined ? '' : `Uncommitted changes (git status --short):\n${clean(h.changes || 'none', HANDOFF_CAPS.changes)}`,
    h.diffstat === undefined ? '' : `What changed on the branch (git diff --stat):\n${clean(h.diffstat || 'none', HANDOFF_CAPS.diffstat)}`,
    h.status === undefined ? '' : `The agent before you (shepherdr status):\n${clean(h.status || 'nothing reported', HANDOFF_CAPS.status)}`,
  ].filter(Boolean)
  if (facts.length) sections.push(`Facts:\n\n${facts.join('\n\n')}`)
  return sections.join('\n\n')
}
