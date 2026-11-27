# The live-session guard

An agent's shell can run `systemctl --user stop herdr.service`, `pkill bun`, `herdr server stop` or `shepherdr update`.
Any of those takes down the Shepherdr and herdr the human is using, with every assistant and task in it. The guard is
the seatbelt for that: a small directory put **first on every agent's PATH** so those few commands meet a wrapper
before the real one.

It is a seatbelt, not a boundary. It stops the ordinary ways an agent, a script it runs, or a prompt-injected command
word would reach `stop`, `restart`, `mask` or `kill`. It does not stop `kill -9 <pid>` with the number, `/run/…/bin/…`
or a Nix store path named in full, a `PATH=` of the command's own, or anything already inside the host's own shell.

## Where it is

`bin/guard/`: five names, `systemctl`, `pkill`, `killall`, `herdr`, `shepherdr`, each a link to `.guard`, one POSIX
`sh` script. It runs no Python, hardcodes no store path, and forks nothing before the command it passes to.

`agentEnv` (`server/live/box.ts`) puts it first for every agent Shepherdr launches — coordinator, task agent, the
reviewers they start, here and on another machine (the helper copies the five files there, `install.ts`) — and sets
`SHEPHERDR_GUARD_PATH` to the PATH as it was. Each wrapper:

1. looks at the command and its arguments (`guard_verdict`, a pure function of them: allow, or refuse with a reason);
2. refusing, prints one line naming who refused it and that the human can run it, and exits 1 without running
   anything else;
3. otherwise finds the real command with `command -v` against `SHEPHERDR_GUARD_PATH` (never this directory) and
   `exec`s it with the arguments untouched. The agent's PATH keeps the guard first, so what that command starts is
   guarded too.

An Autopilot run in its own Linux sandbox gets no guard: it already has no host systemd, PID space, herdr socket or
Shepherdr home to reach.

## Refused

One plain line, exit 1, nothing run:

| command | refused when |
| --- | --- |
| `systemctl` | `stop`, `restart`, `try-restart`, `reload-or-restart`, `kill`, `mask` or `isolate` of a unit named `*herdr*` (so `herdr.service`, `herdr-core`, `shepherdr.service`), `hc-*` (herdr-core's holders), or of `--all`, `default.target`, `multi-user.target`, `graphical.target`, `rescue.target`, `emergency.target`, or a unit glob (`*`, `?`, `[`); `disable --now` of those units |
| `pkill`, `killall` | any name or pattern it is given: a bare name that is the live server or herdr (`bun`, `node`, `perl`, `sh`, `bash`, `dash`, `zsh`, `systemd`, `systemctl`, `herdr`, `herdr-core`, `shepherdr`, `hc-*`); a full-line/regex pattern (`-f`, `-r`) mentioning `herdr`, `shepherdr`, `server/main`, `main.ts`, `cli.ts`, `supervise.ts`, `plugin.ts`, `bun`, `node` or `perl`; a pattern of nothing but wildcards (`pkill -f .`, `killall -r '.*'`) |
| `herdr` | `start`, `stop`, `restart`; `update`; `server stop`; `session stop` or `session delete`, after any `--session`/`--machine`/`--remote` |
| `shepherdr` | `install`, `update`, `uninstall`, `migrate`, `web`, `secrets`; `secret set`, `secret rm`, `secret elevenlabs` — after any leading `--url`, `--space`, `--machine` or `--home` |

A refusal reads, for example:

```text
guard: SHE-21/Agent refused: systemctl --user stop herdr.service would stop the live herdr/Shepherdr unit herdr.service. The human can run it; ask them.
```

## Passes, untouched

Everything else, with its arguments as they were: `systemctl --user status herdr.service`, `systemctl --user
set-property herdr.service CPUWeight=1000`, `systemctl --user restart some-other.service`; `pkill -f vite`,
`killall chrome`, `pkill sleep`; `herdr status`, `herdr pane list`, `herdr agent start …`, `herdr session list`;
`shepherdr task list`, `shepherdr restart SHE-12` (a task's own agent), `shepherdr set heartbeat.when …`,
`shepherdr space remove …`, `shepherdr secret ask …`, `shepherdr merge …`, `shepherdr doctor`.

Some patterns are refused that would not have hurt (`pkill -f 'bun test'`, `pkill -f node_modules/.bin/vite`): a
narrower pattern passes. A shell that unsets `SHEPHERDR_GUARD_PATH` gets "cannot find the real …" and exit 127 rather
than a wrapper that runs itself.

## Not covered

- `kill -9 <pid>` with a number, `kill $(pgrep …)` (pgrep is not guarded), or the same command by its full store path.
- Clearing PATH, `env PATH=…`, or a subprocess started before the guard was on PATH.
- Host root, systemd itself, and anything the human runs outside an agent.
- A pattern the guard's simple globbing reads differently from the tool's own regex.

## Changing it

`guard_verdict` in `bin/guard/.guard` is the policy: pure, `sh`, no I/O. `test/guard.test.ts` holds the table of what
is allowed and refused and runs it directly; the same file proves a refusal never reaches a stub real binary, and that
the launch puts the directory first. Add a case to both.
