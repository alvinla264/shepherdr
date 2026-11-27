// A fixture that takes a while to be ready on a loaded runner: one gate, waited on once, with room to be slow and a
// failure that says what was waited for and what the launcher itself said. Without it every test waits on its own
// short ceiling, and one slow start becomes a page of identical "timed out"s instead of one clear message.
//
// test/gate.test.ts proves both halves with a slow, a refusing and a silent launcher.

/** how long a loaded runner gets before a fixture is called not ready */
export const GATE_MS = 30_000

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface GateOpts {
  /** how long it gets (default GATE_MS) */
  ms?: number
  /** what the launcher said, or which port never answered: read only once it failed */
  why?: () => string | Promise<string>
}

/** Poll `probe` until the fixture is ready. Gives up once, at the ceiling — however long a probe takes, or if it never
 *  answers — with `what` and what the launcher said. */
export async function gate(what: string, probe: () => boolean | Promise<boolean>, o: GateOpts = {}): Promise<void> {
  const ms = o.ms ?? GATE_MS
  let over = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const polling = (async () => {
    // the last probe may still be waiting when the ceiling passes: the timer below ends the gate regardless
    while (!over) {
      if (await probe()) return true
      if (over) return false
      await wait(50)
    }
    return false
  })()
  const ready = await Promise.race([
    polling,
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), ms)
    }),
  ])
  clearTimeout(timer!)
  over = true
  if (ready) return
  const said = (await o.why?.())?.trim()
  throw new Error(`Not ready after ${ms} ms: ${what}${said ? `\n${said}` : ''}`)
}

/** Run a launcher command once and wait for it to answer: its output on success; on failure its own words (exit code,
 *  what it printed) or that it never answered at all. */
export async function launcher(
  cmd: string[],
  ok: (out: string) => boolean,
  o: { ms?: number; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<string> {
  const ms = o.ms ?? GATE_MS
  const how = cmd.join(' ')
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env ?? process.env, stdout: 'pipe', stderr: 'pipe' })
  let answered = true
  const t = setTimeout(() => {
    answered = false
    p.kill()
  }, ms)
  try {
    // both pipes are read to their end: a launcher that dies, or that says something and then hangs, still gets its
    // words into the failure
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    const said = [err.trim() && `stderr:\n${err.trim()}`, out.trim() && `stdout:\n${out.trim()}`].filter(Boolean).join('\n')
    if (!answered) {
      throw new Error(
        `The launcher never answered: ${how} was still running after ${ms} ms, so it was killed (exit ${code}).${said ? `\nWhat it said before that:\n${said}` : ' It said nothing.'}`,
      )
    }
    if (code === 0 && ok(out.trim())) return out
    throw new Error([`The launcher did not start the fixture: ${how} exited ${code}`, said].filter(Boolean).join('\n'))
  } finally {
    clearTimeout(t)
  }
}
