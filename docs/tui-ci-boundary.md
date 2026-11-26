# TUI CI boundary

**Boundary commit:** `2fb1e63932dff6992ae3288910809a8312e4b83e` — "SHE-258: Safe secrets for agents (#455)".
The next commit, `7ab916828f40de769f23164d6d0a9ae23327f7bc` ("SHE-261: Clear titles and UI wording (#456)"), fails
Check on our fork and on upstream. Base fork work on `2fb1e639`.

What that rests on: `2fb1e639` passes, and every newer commit either fails a Check dispatched here (`7ab91682`,
`fdea10ae`, `82b75c64`) or has no passing Check anywhere (upstream: no success after `2fb1e639`; the rest of the
upper half was not individually dispatched). Commits 15–20 and 22–42 were not probed one by one, so a passing Check
among them would raise the boundary; that no such pass exists is not proven, only suggested by the evidence below.

## Method

1. In the fork (`alvinla264/shepherdr`), pushed `probe/<12-char-sha>` at the commit and dispatched
   `check.yml` on it (`gh workflow run check.yml --ref probe/<sha>`); pushes to `main` do not trigger CI here.
   Every probed commit already had `workflow_dispatch` in `check.yml`, so nothing was edited.
2. Binary search over the 42 commits in range order (`v2.0.0` exclusive, `9c0e22ff` first, `ebb17d58` last):
   a passing middle moves the search up towards `ebb17d58`, a failing one down towards `9c0e22ff`, until two
   neighbouring commits are left — the lower one passing, the upper one failing.
3. Upstream's own pushes to main were read as a hint for the starting point only, never as the verdict. That hint put
   the first probes on the pair upstream showed as green-then-red (13, 14); the search then tested the upper half at
   21 and, when that failed, at 16. With 14 failing, no commit at or above it can be the top of the green run, so
   13/14 is the terminal pair. (Midpoint 11 of the remaining lower half was dispatched as a check on the narrowing;
   both of its attempts stalled in runner setup and it has no verdict. It changes nothing: 14 already fails.)

Probes (indices are positions in the table below):

| # | commit | probe branch | fork run | conclusion |
|---|--------|--------------|----------|------------|
| 13 | `2fb1e639` | `probe/2fb1e63932df` | [45772452376](https://github.com/alvinla264/shepherdr/actions/runs/45772452376) | **success** (attempt 2) |
| 14 | `7ab91682` | `probe/7ab916828f40` | [45772455974](https://github.com/alvinla264/shepherdr/actions/runs/45772455974) | **failure** |
| 16 | `fdea10ae` | `probe/fdea10aede9f` | [45775837267](https://github.com/alvinla264/shepherdr/actions/runs/45775837267) | **failure** |
| 21 | `82b75c64` | `probe/82b75c643851` | [45772573122](https://github.com/alvinla264/shepherdr/actions/runs/45772573122) | **failure** |
| 11 | `9611dd0a` | `probe/9611dd0a3cb8` | [45775829548](https://github.com/alvinla264/shepherdr/actions/runs/45775829548) | unknown (cancelled, twice) |

- `2fb1e639`, attempt 1: `test (1/3)` was cancelled after 15 min with the job's `timeout-minutes` while still in
  `bun x playwright-core install-deps webkit`; `types and build`, `test (2/3)` and `test (3/3)` had passed.
  That is a runner stall, not this commit's tests, so the failed job was rerun once (`gh run rerun --failed`):
  attempt 2 passed all four jobs.
- `7ab91682`: `types and build` and `test (2/3)` passed, `test (1/3)` and `test (3/3)` failed — the same two shards
  that failed upstream in 40845087285.
- `fdea10ae`: `test (3/3)` failed in `bun run test`; `test (1/3)` hit the same setup stall, which cannot turn the
  run green.
- `82b75c64`: all three test shards failed (it was `cancelled` upstream, so our run is the evidence that the
  upper half is red here too).
- `9611dd0a`: both attempts stalled in `bun x playwright-core install-deps webkit` and hit the 15-minute job
  timeout; two shards and `types and build` passed on each attempt. Recorded as unknown, not red.

The runner stall above hit two of the five probes; it is a setup step in the runner image, not this line's tests.

## All 42 commits

Upstream `Check` runs with `event: push`, `headBranch: main`. "cancelled" means the verdict is unknown, not red;
"— (no run)" means no run exists.

| # | commit | subject | upstream Check (push, main) |
|---|--------|---------|------------------------------|
| 1 | `9c0e22ff` | SHE-246: AGENTS.md: patch-only releases (#435) | — (no run) |
| 2 | `84cca011` | SHE-245: Stuck sent messages: Remove (#437) | [40773690089](https://github.com/eliasstravik/shepherdr/actions/runs/40773690089) failure |
| 3 | `9a42b95a` | SHE-248: Fix red main: outbox remove test (#438) | [40774898300](https://github.com/eliasstravik/shepherdr/actions/runs/40774898300) success |
| 4 | `e7cdd17b` | SHE-247: README in herdr-projects style (#436) | [40775401348](https://github.com/eliasstravik/shepherdr/actions/runs/40775401348) success |
| 5 | `137814f8` | SHE-249: Restart agent with new settings (#439) | [40783595558](https://github.com/eliasstravik/shepherdr/actions/runs/40783595558) failure |
| 6 | `c0ee1e43` | SHE-252: Fix red main after SHE-249 (#440) | [40784572534](https://github.com/eliasstravik/shepherdr/actions/runs/40784572534) success |
| 7 | `63a8be4b` | SHE-254: Relaunch gone or stale agents (#441) | [40785562214](https://github.com/eliasstravik/shepherdr/actions/runs/40785562214) cancelled |
| 8 | `c431d080` | SHE-255: Doctor ports, supervisor update (#442) | [40785701382](https://github.com/eliasstravik/shepherdr/actions/runs/40785701382) cancelled |
| 9 | `06c613c2` | SHE-253: Read transcripts incrementally (#443) | [40785786518](https://github.com/eliasstravik/shepherdr/actions/runs/40785786518) success |
| 10 | `e21c3c64` | SHE-257: Automations in Everything view (#452) | [40840376831](https://github.com/eliasstravik/shepherdr/actions/runs/40840376831) failure |
| 11 | `7954e544` | SHE-259: Label cards with source task (#453) | [40841334153](https://github.com/eliasstravik/shepherdr/actions/runs/40841334153) success |
| 12 | `9611dd0a` | SHE-260: Fix arrow-key navigation check (#454) | [40843186462](https://github.com/eliasstravik/shepherdr/actions/runs/40843186462) success |
| 13 | `2fb1e639` | SHE-258: Safe secrets for agents (#455) | [40843679960](https://github.com/eliasstravik/shepherdr/actions/runs/40843679960) success |
| 14 | `7ab91682` | SHE-261: Clear titles and UI wording (#456) | [40845087285](https://github.com/eliasstravik/shepherdr/actions/runs/40845087285) failure |
| 15 | `ccedb530` | SHE-265: Faster ordinary answer cards (#460) | [40845426836](https://github.com/eliasstravik/shepherdr/actions/runs/40845426836) cancelled |
| 16 | `fdea10ae` | SHE-263: Simplify notification settings (#461) | [40845460731](https://github.com/eliasstravik/shepherdr/actions/runs/40845460731) cancelled |
| 17 | `8c55b0e5` | SHE-264: Visible model and effort (#462) | [40845683837](https://github.com/eliasstravik/shepherdr/actions/runs/40845683837) cancelled |
| 18 | `2e752380` | SHE-270: Fix task header check failure (#463) | [40845877323](https://github.com/eliasstravik/shepherdr/actions/runs/40845877323) cancelled |
| 19 | `4da1053f` | SHE-266: Improve tablet and side panes (#464) | [40846084090](https://github.com/eliasstravik/shepherdr/actions/runs/40846084090) cancelled |
| 20 | `4f643ea5` | SHE-262: Clear attention across machines (#465) | [40846224327](https://github.com/eliasstravik/shepherdr/actions/runs/40846224327) cancelled |
| 21 | `82b75c64` | SHE-267: Search tasks messages artifacts (#466) | [40846688393](https://github.com/eliasstravik/shepherdr/actions/runs/40846688393) cancelled |
| 22 | `e4fd736a` | SHE-269: Fix remote agent command routing (#467) | [40846948344](https://github.com/eliasstravik/shepherdr/actions/runs/40846948344) cancelled |
| 23 | `a74374a5` | SHE-271: Restore controls to plus popup (#468) | [40847000297](https://github.com/eliasstravik/shepherdr/actions/runs/40847000297) failure |
| 24 | `5a311460` | SHE-272: Undo collapsed task updates (#469) | [40847847628](https://github.com/eliasstravik/shepherdr/actions/runs/40847847628) failure |
| 25 | `70670faf` | SHE-273: Simplify restart dialog (#470) | [40848693753](https://github.com/eliasstravik/shepherdr/actions/runs/40848693753) failure |
| 26 | `9d6556bc` | SHE-274: Show actual model and effort (#471) | [40850285875](https://github.com/eliasstravik/shepherdr/actions/runs/40850285875) failure |
| 27 | `99932f78` | SHE-277: Authenticate agent secret access (#474) | [40874764989](https://github.com/eliasstravik/shepherdr/actions/runs/40874764989) failure |
| 28 | `903cd438` | SHE-278: Heal machine links after blips (#475) | [40882622368](https://github.com/eliasstravik/shepherdr/actions/runs/40882622368) cancelled |
| 29 | `59d7b056` | SHE-279: Remove chat attention summary (#476) | [40882767679](https://github.com/eliasstravik/shepherdr/actions/runs/40882767679) failure |
| 30 | `0f918228` | SHE-281: Fix Apple push delivery (#478) | [40884672546](https://github.com/eliasstravik/shepherdr/actions/runs/40884672546) cancelled |
| 31 | `aa68459b` | SHE-287: Clarify supported chat agents (#479) | [40884716074](https://github.com/eliasstravik/shepherdr/actions/runs/40884716074) cancelled |
| 32 | `a477b5c4` | SHE-282: Fix first-start installation (#477) | [40884832122](https://github.com/eliasstravik/shepherdr/actions/runs/40884832122) cancelled |
| 33 | `7cdba004` | SHE-283: Route news to requesting space (#480) | [40885166797](https://github.com/eliasstravik/shepherdr/actions/runs/40885166797) cancelled |
| 34 | `a2642478` | SHE-286: Configure task IDs in Settings (#481) | [40885339881](https://github.com/eliasstravik/shepherdr/actions/runs/40885339881) cancelled |
| 35 | `73346e25` | SHE-291: Clear stale task startup errors (#482) | [40885524764](https://github.com/eliasstravik/shepherdr/actions/runs/40885524764) cancelled |
| 36 | `4599c3f9` | SHE-284: Add private agent instructions (#483) | [40886126656](https://github.com/eliasstravik/shepherdr/actions/runs/40886126656) cancelled |
| 37 | `f44719a6` | SHE-292: Unify ready and needs-you badges (#485) | [40886398616](https://github.com/eliasstravik/shepherdr/actions/runs/40886398616) cancelled |
| 38 | `b9d27622` | SHE-285: Choose task base branches (#484) | [40886522333](https://github.com/eliasstravik/shepherdr/actions/runs/40886522333) failure |
| 39 | `f7bd2059` | SHE-293: Clarify automation task label (#487) | [40901744535](https://github.com/eliasstravik/shepherdr/actions/runs/40901744535) failure |
| 40 | `12931761` | SHE-294: Show full briefs as plain text (#488) | [40902983224](https://github.com/eliasstravik/shepherdr/actions/runs/40902983224) failure |
| 41 | `bcaa2ca4` | SHE-296: Fix voice in remote chats (#489) | [40906888093](https://github.com/eliasstravik/shepherdr/actions/runs/40906888093) failure |
| 42 | `ebb17d58` | SHE-295: Build coordinator Autopilot (#490) | [40916895905](https://github.com/eliasstravik/shepherdr/actions/runs/40916895905) failure |

## What is and is not proven

- Proven on our fork: `2fb1e639` passes; `7ab91682`, `fdea10ae` and `82b75c64` fail; `main` (`74da1e63`, v2.0.0)
  passed in 45763565610.
- Not proven: that no commit older than `2fb1e639` after the last known red one passes (1–12 were not dispatched
  one by one), and that no commit above the terminal pair passes (15–20 and 22–42 were not dispatched one by one).
  Upstream has no passing Check for any commit after `2fb1e639`, and the two upper-half probes that ran here failed,
  so the boundary is where the evidence points — not a scan of all 42 on our runners.
- `9611dd0a` (11) is unknown, not red: both attempts were cancelled by the runner setup stall.
- The 42 upstream runs are upstream's runners, not ours; they are cited as hints only.
