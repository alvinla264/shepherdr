// What a pane's foreground holds, from herdr's pane.process_info: the chat's own CLI, its shell at the prompt, or
// something else a human started there (an editor, a pager, a test). Shepherdr types into a pane only while the agent
// is in it: an agent's CLI exits or is lost, the pane falls back to a plain shell, and words meant for the agent would
// run there as shell commands (SHEP-324). The one classifier every send path goes by.
import { isAgentProcess } from './agent-process.ts'
import type { ProcessInfo } from './herdr.ts'

/** what holds a pane: its chat's CLI, its shell sitting at its prompt, something else, or no pane at all */
export type PaneState = 'agent' | 'shell' | 'other' | 'gone'

/** what herdr said of a pane; nothing when it has no such pane (its agent is gone) */
export type PaneLook = { pane_id: string; state: PaneState | 'unknown'; program?: string }

const argvOf = (p: { argv?: string[]; name?: string }) => p.argv ?? (p.name ? [p.name] : [])

/** What a pane's foreground holds. `kind` is the CLI the chat expects: another agent in the pane is not the one a
 *  message was meant for. `info` is what herdr reports of the pane, nothing when it reports none. */
export function paneState(kind: string, info: ProcessInfo | undefined | null): PaneState {
  if (!info) return 'gone'
  const running = info.foreground_processes ?? []
  if (running.some((p) => isAgentProcess(kind, argvOf(p)))) return 'agent'
  // the shell is in the foreground, at its prompt: what ran in it has ended
  if (info.shell_pid && info.foreground_process_group_id === info.shell_pid) return 'shell'
  return 'other'
}

/** the program a pane holds when it isn't the agent, for the words that say why nothing was typed */
export function paneProgram(info: ProcessInfo | undefined | null): string | undefined {
  const p = info?.foreground_processes?.[0]
  if (!p) return undefined
  const base = (s?: string) => s?.split('/').pop() ?? ''
  const first = base(argvOf(p)[0])
  // npm's node or bun entry point: the program is the script it runs ("bun test" runs no script: it is bun)
  const entry = argvOf(p)[1]
  if (/^(?:node|bun)(?:\.exe)?$/.test(first) && entry?.includes('/')) return base(entry)
  return p.name ?? (first || undefined)
}

/** Nothing was typed: the pane holds a shell, another program, no pane at all, or herdr didn't say what runs there.
 *  Its message is plain words for the chat. */
export class PaneMissing extends Error {
  constructor(readonly state: PaneState | 'unknown', message: string) {
    super(message)
    this.name = 'PaneMissing'
  }
}

/** a shell or no pane is looked for again once the agent is back; another program is left to the human */
export const waitsForAgent = (e: unknown) => e instanceof PaneMissing && (e.state === 'shell' || e.state === 'gone')
