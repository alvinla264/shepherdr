# Why a big chat stalls the screen, and what to do about it

A chat whose agent has run for days holds thousands of messages and tens of MB of logs. Opening it freezes the whole
screen — not just the chat pane — for seconds, and while the agent keeps working the screen freezes again about once a
second. This page says what actually costs the time, with measurements from this machine, and ranks the fixes.

The earlier fix on this line (`06c613c2`, "Read transcripts incrementally") did its job: reading 40 MB of log costs
114 ms in 20 pieces, longest piece 12 ms, and never blocks a request for long. What is left is everything *after* the
read: the chat is rebuilt whole for every change, sent whole, and drawn whole, every message into the DOM.

## How it was measured

Everything below was run from this worktree, at `nice -n 19`, on a throwaway server on a loopback port with
`SHEPHERDR_HOME` under `/tmp`; `~/.shepherdr` and the live server were never touched.

- **Fixture.** A Claude Code transcript written the way the CLI writes it (`sessionId`/`uuid`/`timestamp`, `user`
  prompts, `assistant` replies with markdown text plus a `tool_use` block, `tool_result` lines ~8 KB, `usage`,
  `system`/`turn_duration`), 2 messages per turn: 5 000 turns = **40.3 MB of log, 15 000 messages**. Smaller sizes are
  the tail of the same file (`n` messages), so message text and shape are identical at every size.
- **Server side.** `Chats` with a fake `Agents` record (nothing else in `chat()` needs herdr), the real `LogTail` and
  `ClaudeReader`: cold read piece by piece, then `chat(key)` and `JSON.stringify` of the payload.
- **Client side.** The real built screen (`vite build`) served by the real `startApp` with the demo world, whose chat
  holds the real payload the server produced; Chromium at 390×844; `PerformanceObserver` long tasks,
  `Performance.getMetrics` for layout/script time, CDP `Runtime.getHeapUsage`, and a CPU profile
  (`Profiler`, 200 µs sampling) for attribution.

## What stalls

### 1. The screen draws every message it has (client, the stall)

Opening a 15 000-message chat: **first row painted after 5.9 s, one main-thread block of 5.2 s, 5.9 s of blocking in
all, 315 253 DOM nodes, 146 MB JS heap.** A tap on the composer was answered after 4.4 s. The main thread is the one
that also handles taps, scrolling and the rest of the UI, which is why "the rest of the UI" is unresponsive, not just
the chat.

Nothing caps what is drawn: `plugins/chat/client.tsx:1191` (`Messages`) turns *every* message into a row and
`plugins/chat/client.tsx:1227` renders them all, with no windowing, so the DOM grows with the chat's whole history.

| messages | payload | first row | longest block | blocking | DOM nodes | heap |
|---:|---:|---:|---:|---:|---:|---:|
| 200 | 0.06 MB | 224 ms | 90 ms | 40 ms | 4 454 | 7 MB |
| 1 000 | 0.28 MB | 538 ms | 390 ms | 340 ms | 21 265 | 14 MB |
| 3 000 | 0.84 MB | 1 327 ms | 1 074 ms | 1 135 ms | 63 251 | 34 MB |
| 7 500 | 2.09 MB | 3 024 ms | 2 619 ms | 2 920 ms | 157 752 | 77 MB |
| 15 000 | 4.17 MB | 5 930 ms | 5 166 ms | 5 918 ms | 315 253 | 146 MB |

### 2. Every change re-sends and redraws the whole chat (client and server, the recurring freeze)

While an agent works, `server/live/source.ts:259` polls every second; when anything changed,
`server/live/source.ts:717` (`pollChats`) emits `chat`, `server/app.ts:76` calls `source.chat(key)` and sends the
**entire** chat JSON to every open screen, and `src/kernel.ts:729` replaces the whole chat object, so the screen
redraws all rows. Measured on the same 15 000-message chat, one update:

| | longest block | blocking per update |
|---|---:|---:|
| before this change | 1 353–1 428 ms | ~2 100 ms |
| after this change | 834–855 ms | ~1 500 ms |

A freeze of 0.85–1.4 s every second while an agent runs is the "unresponsive UI" the human sees; the connection also
carries 4.17 MB per update.

### 3. The chat is rebuilt from all its events on every change (server)

`server/live/chats.ts:694` (`chat`) walks every event and every posted card and builds every message, view model
included, on each call: **15.6 ms for 6 000 messages, 74.8 ms for 15 000** (median of 15). That is 7 % of one core at
one poll a second for one open chat. It also runs inside `snapshot()` for unread counts and, in
`server/live/source.ts:543` (`withAsks`), **once per distinct task
named by a needs-you card in a space's chat** (`chatOf` at `server/live/source.ts:548`). A coordinator's chat with
thirty such cards therefore rebuilds thirty agent chats per emitted change: ~2.2 s of server CPU per second by that
code path alone (estimated from the 74.8 ms per build; the card count on the human's own data was not read).

### 4. Two per-message costs on the way in and on every redraw (client, the difference between "slow" and "frozen")

The CPU profile of opening the big chat, before this change (self time):

| 2 394 ms | `measure` (`plugins/chat/fold.tsx`) |
| 1 021 ms | browser work (style, layout, DOM insertion) |
| 559 ms | `Row` (`plugins/chat/client.tsx`), nearly all of it `toLocaleTimeString` |
| 157 ms | `toHtml` (marked + DOMPurify) per new reply |

- `fold.tsx` read `offsetHeight` in a `useLayoutEffect`, once per message, while React was still putting thousands
  of rows into the DOM. Instrumented, that read cost **0.22 ms each: 448 ms for 2 000 rows, 2 002 reads**. The same
  read inside the `ResizeObserver` callback, where layout is clean, costs **0 ms** (1 002 reads). A prototype that let
  the observer do the measuring (dropping the synchronous read) took the longest block on the same chat from 5 166 ms
  to 3 052 ms; it is **not** part of this change, because the first frame after a mount would then paint a tall reply
  unfolded, before React commits the fold — a real visual jump (a review finding). Doing it properly is scroll and
  arrival work, i.e. the same place as (1) below.
- `Row` built a fresh `Date#toLocaleTimeString` formatter for every message on every redraw: **283 ms per 10 000
  rows**, against 41 ms for one `Intl.DateTimeFormat` reused (measured in the page in isolation). In place it cost the
  load about 790 ms of the longest block, and each live update about 570 ms (tables below).

## The change made here (small, safe, measured)

One edit, two lines, no API change: `plugins/chat/client.tsx:1007` keeps one `Intl.DateTimeFormat` for every row
instead of `toLocaleTimeString` building a formatter per message per render.

| messages | first row before → after | longest block before → after | DOM nodes | heap |
|---:|---|---|---:|---:|
| 200 | 224 → 201 ms | 90 → 84 ms | 4 454 | 6 MB |
| 1 000 | 538 → 481 ms | 390 → 324 ms | 21 265 | 14 MB |
| 3 000 | 1 327 → 1 157 ms | 1 074 → 896 ms | 63 251 | 33 MB |
| 7 500 | 3 024 → 2 635 ms | 2 619 → 2 193 ms | 157 752 | 77 MB |
| 15 000 | 5 930 → 5 144 ms | 5 166 → 4 420 ms | 315 253 | 150 MB |

Per live update: longest block 1 353–1 428 → 834–855 ms, blocking ~2 100 → ~1 500 ms.

It is a modest but real improvement, and it is provable (the numbers above, plus `test/layout-chat-load.test.ts`, which
opens a 303-message chat, folds every tall reply and checks each message's time against the browser's own). It is not
the fix: **the screen still freezes for about 0.85 s per update on a chat this size**, because the remaining cost is
drawing and reconciling ten thousand rows, which no micro-optimisation removes. It buys most where it was aimed: one
update costs 40 % less main-thread block than before. (Windowing, below, removed that remaining cost.)

## Candidate fixes, ranked

1. **Draw only what is near the viewport (windowing).** *Done: see "Windowing" below.* Render a window of messages
   around the scroll position (say 40 above and 40 below), with spacers keeping the scrollbar honest. This is the fix for
   the stall, not a mitigation:
   the DOM stops growing with history. Measured proxy: the same payload at 200 messages costs 224 ms to first row,
   90 ms longest block, 4 454 nodes. Estimated: a 15 000-message chat opens in ~0.3 s, updates in <100 ms, heap in
   the tens of MB. Cost: the real work (~200–400 lines) is in the edges the chat already relies on — arrival
   animations, the "New" line, jumping to a search hit or a quote, albums, fold measurement, scroll anchoring, the
   scroll-to-bottom behaviour on a phone. Risk: medium-high, but testable by the existing `layout-*.test.ts` files.
2. **Page the payload.** `GET /api/chat?chat=…&before=<id>` returns the newest N messages plus a cursor; the screen
   asks for older ones as it scrolls back. Cuts the server's 74.8 ms build and the 4.17 MB transfer to ~5 ms and
   ~0.3 MB, and halves the client's mount work for a first paint. Risk: medium — it changes the shape of the API (the
   brief for this task did not allow that), and the server's unread/attention/needs-you logic reads all messages
   today (`shared/alerts.ts`, `server/live/source.ts:238`), so it needs to keep a cheap full-history index separate
   from what it sends. Do this *after* (1) or together with it; alone it fixes the first paint but not the redraw.
3. **Send deltas instead of the whole chat.** Keep the last built `Chat` per key; on change send only appended
   messages and replaced ones (the tail a streaming reply grows). Client merges by id. Removes the 4.17 MB/update and,
   with a memoized row, most of the per-update React work. Cost: medium-high — message ids are stable but the built
   list is re-sorted and cards/artifacts are spliced in (`chats.ts:694`–`959`), so a delta needs a sequence number and
   a resync path. Risk: medium; a missed delta shows a stale chat.
4. **Rebuild a chat only when its events changed, and once per poll.** `chat()` is called by `snapshot()`, `withAsks`
   and each emit; caching the built `Chat` against `(events.length, posted.length, last status)` would cut the
   74.8 ms to a few ms in the common case, and `withAsks` should refresh only the cards that are still waiting rather
   than one build per task named by any past card (`source.ts:548`). Estimated: up to 2 s/s of server CPU on a busy
   coordinator chat; ~30 lines. Risk: low-medium (a stale cache shows a stale status).
5. **Stop re-reading and re-scanning unchanged logs.** The tails already only read new bytes, but `jobsChanged()`
   re-scans every event and `JSON.stringify`s the jobs every second per chat, and `activityOf()` walks all events
   inside `chat()`. Cache per `(events.length)`; ~20 lines, a few ms per second per chat. Risk: low.
6. **Let the fold's observer do the measuring of a reply.** Prototype measured above: longest block −41 % on open. Only
   worth doing together with (1), because alone it paints a tall reply unfolded for one frame before React commits the
   fold.

## Recommendation

Do **1 (windowing)** first — done, below — then **5** and **4** as cheap follow-ups; keep **2** and **3** as the next
step only if windowing alone is not enough on the human's real device, or look at what the profile says now (below).
Windowing is the only candidate that makes the cost independent of how long an agent has been running, which is the
actual shape of the problem; the payload and delta work reduce bytes but leave the client drawing the same number of
rows. What is left after it is the server rebuilding the chat (`chat()` at 74.8 ms for 15 000 messages) and the
transcript bytes: (5), (4) and then (2)/(3).

## Windowing (the fix)

The chat now draws only the messages near what it shows: 120 at its newest message, and around the scroll position
otherwise — 40 above what shows and 40 below (`plugins/chat/window.tsx`), with a spacer above and below standing in for
the rest (`plugins/chat/window.ts`). Rows are keyed, so the React elements of the ones left out are never built; each
row sends what it measured to the next draw (heights are kept by message key, the list's offset of the first row drawn
is carried as rows are measured, never recomputed from an average), so what shows stays where it showed, the scrollbar
stays honest, and a jump to a message or to the bottom lands where it used to. `jumpTo` asks the chat to draw a message
it cannot find (a search hit, a quote, an alert's link) and looks again as it is drawn.

Same fixture, same machine, Chromium at 390×844, one throwaway server per run, `SHEPHERDR_HOME` under `/tmp`, nice 19:

| | before | after |
|---|---:|---:|
| first row painted | 4 075 ms | 306–383 ms |
| longest main-thread block | 3 873 ms | 138–144 ms |
| blocking on open | 4 537 ms | 197–261 ms |
| DOM nodes | 305 253 | 2 691 |
| JS heap | 146 MB | 14 MB |
| longest block, one live update | 722–754 ms | 89–104 ms |
| blocking per live update | 1 281–1 837 ms | 150–163 ms |
| scrolling 20 screens up | 594 ms longest, 3 007 ms blocking | 0 ms, 0 ms |

The fixture is rebuilt with the shape above but is not byte-for-byte this page's: 5 000 turns, 44.7 MB of log,
15 000 messages, 3.35 MB payload (this page's was 4.17 MB). Its "before" numbers land where this page's 15 000-message
column does, which is what makes the comparison worth reading.

**The fold's synchronous read (§4).** It is now taken only for a row drawn for the first time, and a row drawn again
(the window draws it back as you scroll) is folded at once from what it measured before (`plugins/chat/fold.tsx`).
Opening the same chat read a row's height 10 000 times, 1 747 ms; it now reads 81, 20 ms. The §4 prototype (let the
observer alone measure) would therefore buy about 20 ms and still paint a tall reply unfolded for a frame on its first
draw, which windowing makes *more* visible (rows appear as you scroll), so it stays out.

What holds it: `test/chat-window.test.ts` (the arithmetic), and `test/layout-chat-load.test.ts`, which opens a chat of 400
messages and checks that only the rows near what shows are drawn, that scrolling to the top draws the oldest, that the
arrow back to the bottom lands on the newest, that a reply taller than the screen still folds, and that a quote's jump
to a message far outside the window draws it and lands on it. Every other `layout-*.test.ts` is the net for the rest of
the chat's edges (they run on GitHub: this machine runs none).

## What was deliberately not done

- No redesign, no API change: the investigation's brief asked for an investigation and at most a small provable fix.
- The fold prototype was measured (longest block 5 166 → 3 052 ms) and then left out: it paints a tall reply unfolded
  for one frame before the fold is committed. Windowing kept it out (see above), and the per-row read it would save is
  now 20 ms.
- The measurement scripts (fixture generator, server bench, Playwright sweep, CPU profile) are throwaway and are not
  committed; the fixture shape and every number above are reproducible from what this page describes.
- The 95 MB / 2 113-message case from the earlier fix was not re-run; this page uses a 40 MB / 15 000-message fixture
  instead, which is harder on the client (more messages) and easier on the reader.
- Server amplification in `withAsks` is reasoned from the code and the measured per-build cost, not measured on a chat
  with many needs-you cards; the human's real data was not read.
- No change to `shared/types.ts`: the payload keeps its shape, so the fix above stays inside the screen.
- Tests could not be run on this machine (`AGENTS.md`): only `bun run typecheck` was run here, and the new browser test
  and the existing `layout-*.test.ts` files are left to GitHub's check.
