# Autopilot

Autopilot is a brief, a wake-up schedule and a constrained coordinator. Settings → Autopilot has one editable
plain-text **Heartbeat**: direction, priorities, constraints, evaluation, reporting, escalation and an optional
stopping goal all belong there. Generated launch settings follow it as ordinary text. There are no mission,
evaluation or reporting forms and no mission dashboard. Task briefs and Heartbeat use the plain-text treatment
introduced in SHE-294.

An ongoing instruction such as “keep improving the game” has no invented stopping target. A finite goal such as
“halve startup time” ends when the coordinator proves it, saves evidence and calls `shepherdr complete "evidence"`.
Each wake reads Heartbeat and saved progress, inspects Shepherdr with its tools, chooses permitted useful work,
acts, evaluates evidence and saves progress/next step with `shepherdr progress "…"`.

When, Events and time zone reuse the existing trigger machinery. Selected events wake immediately; other news
waits for the next heartbeat. Run now queues a wake until the coordinator is idle. Next and Last show schedule,
time, wake reason and delivery/turn outcome; a turn ending is not a claim that the goal succeeded. The coordinator's
actual messages and saved progress carry its results; Shepherdr generates no separate status report.

Turning ON closes/replaces the regular coordinator with a fresh selected Autopilot session. OFF starts a fresh
regular coordinator using normal defaults. The chat key, old transcripts, queued human messages and saved progress
stay. During replacement, messages wait and new launches are blocked. Old-run events are discarded. Failed starts
leave Autopilot stopped with the error; they never launch an unrestricted fallback. Retry by applying settings or
turning OFF/ON. Changing launch/access settings while ON replaces the coordinator and stops its owned workers.

Task/reviewer defaults are reused. Agent, Model and Effort accept optional Autopilot overrides; `inherit` follows
the regular coordinator default and `default` uses the selected CLI's own default. An incompatible inherited model
or effort is refused rather than silently substituted. Automatic fallback is disabled for owned tasks.
Before an isolated launch, the new pane switches to a clean non-login `/bin/sh`; its actual process arguments and
wrapper PATH are verified before Herdr starts any agent. A shell configuration that cannot make this handover is refused.

## Capabilities and limits

| Runtime | Claude Code | Codex | pi | Other Herdr agents |
| --- | --- | --- | --- | --- |
| Shepherdr chat reader, model/effort adapter | Yes | Yes | Yes | Not currently viable for coordinator chat; refused |
| Shared Linux isolation, schedule, fresh mode replacement | Yes | Yes | Yes | Refused |
| Local Linux repository space with usable bubblewrap namespaces | Required | Required | Required | — |
| Remote workers, macOS, home-space Autopilot | Currently refused | Currently refused | Currently refused | — |

The **Isolated workspace** profile uses bubblewrap PID, mount, user and network namespaces, drops capabilities,
clears inherited environment and starts with a private provider home. It applies to the whole process tree,
including shell commands, native helpers and headless reviewers, regardless of their own sandbox flags. System executables, libraries and certificate configuration are read-only. Other host
home files, Herdr/Shepherdr control sockets and local/private network are absent. The coordinator sees its project read-only;
workers can write only their own worktree and private runtime home. Host Git metadata is read-only. A worktree
containing hardlinks to shared files is refused rather than exposing those shared inodes for writing.

Exact public HTTPS host names are allowed through a trusted CONNECT gateway. Wildcards, arbitrary ports, direct
network access and private/loopback/Tailscale destinations are blocked. Provider clients must honor the HTTP(S)
proxy. This limits CONNECT destinations and their resolved public IPs; encrypted application traffic is not inspected,
so another service hosted on the same IP may be reachable. Custom providers may need their public host added; a local provider is unsupported. Failure never enables
host networking. Provider configuration is copied selectively: host MCP executors, hooks and installed plugins
are not imported. The selected agent and reviewer login files are copied into the private home; the host login files are not overwritten.
A login that cannot work in the isolated runtime needs the human; it never falls back to another account.

The gateway fixes command chat/cwd identity itself. A caller cannot choose another task, secret scope or permission
profile. Secret values use the existing masked CLI flow, only for names explicitly in this profile. Settings,
deleting tasks, unrelated work and host-file artifacts require the human. Merges require human approval by default;
choosing `none` permits managed-task merges while each task brief's merge policy still applies. Workers save a
commit using `shepherdr checkpoint "message"`; this broker operation stages their worktree and commits with hooks, filters, custom Git credential helpers
and filesystem monitors disabled. Broker Git uses normal SSH configuration or the authenticated GitHub account;
workspace-controlled scripts are not run on the host. Custom clean/smudge filters and custom SSH command wrappers
are unavailable through this broker. Direct Git metadata writes are refused.

Each task stores its trusted run owner before startup. Cross-harness managed workers inherit the same profile.
Turning OFF stops owned workers by default; “Turn off; let workers finish” keeps their existing boundaries and shared
allowance/deadline. Unrelated earlier tasks are neither stopped nor relabelled. Native descendants stay inside their
parent's namespace, and stopping that runtime kills the namespace. Server restart fails closed: old runs stop and
need explicit retry, rather than being revived without their gateway.

Access and limits are behind an expansion:

- **Shared HTTPS allowance (MiB):** a hard cap on encrypted traffic through the gateway, both directions, including
  coordinator, workers and reviewers. It measures network traffic, not tokens or money. A chunk that exceeds the
  remaining allowance is refused. Exhaustion closes the run.
- **Shared reported tokens:** an optional best-effort stop threshold using every transcript in the runtime homes,
  including helpers and reviewers. Log bytes are captured from inside the namespace into host-owned storage, never
  opened from an agent-supplied host path. Reports are delayed and agent-written, so they can overshoot or be missing; this
  is not a hard token or money cap. No exact financial spending cap is offered.
- **Shared runtime:** elapsed wall time since ON, including idle time. Every runtime gets the same absolute deadline
  through an external timeout; the manager also checks it. This ends all descendants, not just a turn.
- **Maximum parallel tasks:** the number of active managed Shepherdr tasks belonging to this run. It does not count
  native helper processes as separate tasks; they share their parent's namespace, network allowance and deadline.

The new `autopilot.*` settings, `autopilot-run` action, optional mode `keepWorkers` and optional
`SettingRow.instructions` are additive. Existing plugin names, `definePlugin` and registry slots remain unchanged.

## Pi background jobs and conditional nudges

With the companion `tedious_task` extension, an idle Pi may be waiting for a detached job to finish and wake it.
On the local Linux host, Shepherdr reads a private, atomic lease in `~/.local/state/shepherdr-pi-jobs/`, matched to
Herdr socket, pane and Pi session. It accepts only a fresh (30s), owner-only regular file with a matching live
process/start time and boot identity. Leases renew every 5s without changing the activity revision. No command,
output or credential is published. Other CLIs retain their existing background detection; remote helpers do not
read local leases. Missing or stale state is unknown, not evidence that no jobs run.

`shepherdr task show <id> --json` includes `runtime.backgroundJobs` and `runtime.observed`. Automatic continuations
use `shepherdr task nudge <id> "<continuation>" --observed "<runtime.observed>"`, not `task tell`. It rechecks after
asynchronous preparation and never starts a worker or queues a nudge for later. Pi also checks the activity revision
and its own idle/pending-job state when the input arrives; a resumed worker discards a stale continuation. Submission
is not an acknowledgement that Pi accepted it. Ordinary chat and `task tell` are unchanged.

An auto-waking job or a queued completion keeps the task at work unless it has an explicit question/permission
prompt. Silent waiting alone is not stalled news during the first 30 minutes of the oldest auto-waking job. An
exceeded estimate or longer wait still raises news for inspection; a conditional nudge continues to skip pending
work. Investigate the job/deadline and use a deliberate intervention only when justified. Jobs whose notifications
were disabled do not promise a wake or suppress silence checks. A delivered notification has at most 30s of handoff
grace; the next Pi run clears it. Session shutdown removes the lease, and stale/crashed records expire.

The extension changes take effect on the next load. Do not reload a worker with running jobs: its existing shutdown
handler terminates its detached jobs. Existing coordinators need to read the updated coordinator skill before
using the new supervision procedure.
