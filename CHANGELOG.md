# Changelog

## 0.5.33 - 2026-11-24

- Fix: a HANDOFF order whose submit the host dropped is delivered, never left for a person to type (eve, session 801d7b9a, 19:47; the User: "Why is this saying it dropped it? Thats not good enough."). The log said `handoff order submit DROPPED after 1 ms (the session was stopped and nobody has sent input since); the next prompt that enters carries the order`. An idle session at its threshold then sat with no handoff until someone typed, the opposite of what the order is for.
- A dropped or thrown `$.prompt.submit` now falls through two routes (`deliverByFallback`, hooks/handoff.ts), in order: (1) console: the order line is typed into the session's idle console through the 0.5.31 helper (`consoleType`, hooks/console-clear.ts; same idle and empty-prompt-box checks, Windows only; a line over 24 characters is typed first and Enter 400 ms later so it is not read as a paste with the Enter inside); (2) peer: `hooks/deliver-order.ts` writes `peer-send.py` next to the handoff files and runs it through `$.process.run`; it calls `tools/peer/send.py`'s `send()` of the orchestrator tree for the tree of the session's root (`peerlib.tree_of_cwd`) with `act=True`, which starts a stopped tree. The sender is the machine sender `heartbeat` named `fast-jev-compaction` (a sender read from the process chain would be the target session itself, which send.py refuses as "a session does not message itself"). There is no retry route: the host has no event for "this session can take input now".
- The log names the route that delivered (`handoff order DELIVERED by the console route ...; tried: ...`). `DROPPED` is logged only when every route failed, with the submit reason and each route's error (`handoff order submit DROPPED, every route failed (...)`); the next prompt that enters still carries the order as context.
- One delivery per order: a route runs only while this order is still the pending one (`pendingOrders`, the order marker) and no prompt has carried it or a route delivered it (`deliveredOrders`, shared with the carry-as-context code in fast-jev.ts, reset when an order is queued or its marker is cleared). A prompt that is the order itself (the typed line, the peer message) carries no second copy.
- Wired at both places that queue an order: the turn-end step and the ratio-miss path (`ratioMiss`), which had no console wiring before.
- Loader rules kept: `$` is passed to top-level functions, never bound, no member existence test.
- Tests (tests/forced-handoff.test.ts, 10 new): submit ok runs no route; drop then console ok (peer never asked, text and split flag checked); thrown submit; drop, console busy, peer ok; every route failed logs DROPPED with each reason; helpers returning nothing; the order marker cleared during the console route stops the peer route; a delivered order is not carried again; a failed delivery is still carried as context.
- Never run live: the peer helper under the plugin host's `$.process.run` (is `python` on its PATH, does the child show a window), and the split Enter of the console helper with a 300 character line. After install read `~/.claude/fast-jev-compaction.log` for `handoff order DELIVERED` and `handoff order submit DROPPED`.

## 0.5.32 - 2026-11-24

- Fix: 0.5.31 did not load. A session restarted on it at 19:21 ran with no plugin: `hooks module fast-jev-compaction@fast-jev-compaction failed to load ... 0.5.31\hooks\platform.ts, compiled line 14 if (host?.env && await host.env.get("OS") === "Windows_...`. Same class as 0.5.26 to 0.5.28: the hooks loader follows `$` into the functions it is passed to and refuses any value use of it or its members (an optional chain, an existence test, a bind).
- `detectWindows` (hooks/platform.ts) no longer tests `host?.env`; it calls `host.env.get(...)` inside a try, so a host with no env throws into the catch and the next signal runs. Every other 0.5.31 line in hooks/ was read for the same form (`host?.x`, `if (host.x)`, `host.x &&`, `typeof host.x`, a member passed or bound): the only other member uses are `host.fs.stat` and `host.fs.read` in color-carry.ts, both called inside try. None found.
- Test: `tests/host-loader-contract.test.ts` gains an AST check over every hooks file: any optional chain on a member of `$` or `host`, and any member of them that is not the callee of a call (existence test, `typeof`, bind, pass), fails. Run against the 0.5.31 platform.ts it fails with `40:9: optional chain on a host member: host?.env`; on this code it passes. Plus two sample cases (the 0.5.31 form must fail, a call inside try with `!` or a cast must pass).

## 0.5.31 - 2026-11-24

- Fix: the Windows check works in the plugin host (tk-2a7dt9, found 11-18). Each hook file had its own `onWindows()` reading `globalThis.process?.platform`; in the host that is not visible, so it was false in every session on the Windows PC. Effects since 0.5.17: handoff.ts ran `rm -f` and `mv -f` (`could not delete ... order.json; rewrote it as order none`), color-carry ran `grep` (`could not read the session color`), and the 0.5.17 console clear fallback was left undefined (`onWindows() ? ... : undefined`), so a clear refused after a stop was never typed into the console.
- New `hooks/platform.ts`, one shared `detectWindows(host, hintPaths)`: `process.platform === 'win32'` when visible (only a yes counts), else a drive-letter or UNC path among the paths about to be used, else `$.env.get('OS') === 'Windows_NT'`, else `$.env.get('SystemRoot')` as a drive path. Never throws. `onWindows()` is gone from handoff.ts, color-carry.ts, console-clear.ts, standing.ts and fast-jev.ts. `HandoffHost`, `ColorHost` and the console helper's host take an optional `env`.
- handoff.ts: `moveArgv` and `deleteArgv` build the commands. Windows: `cmd /c move /Y` and `cmd /c del /F /Q` with backslash paths (the host `$.fs` has no rename and no delete, so there is no `fs.rm` to use; cmd is on every Windows). A failed delete still rewrites the marker as `order none`.
- color-carry.ts: no grep for a transcript the host can read itself. `readSessionColor` stats the file; up to 3.5 MB (`$.fs.read` rejects over 4 MiB) it reads it with `$.fs.read` and filters in JS (`colorFromText`). A bigger one, a failing stat or a failing read goes to the child process as before: `findstr` on Windows (ships with it), `grep -a` elsewhere (`scanArgv`). `host.fs.stat` is called inside a try, never tested for existence (0.5.28 loader rule).
- console-clear.ts: `consoleClear` checks the platform itself and returns `{ ok: false, error: NOT_WINDOWS }` off Windows, so fast-jev.ts always passes it and standing.ts always tries it after a stopped-session refusal. The helper's own safety is unchanged: it types only into an idle console with an empty prompt box.
- readTail: no longer exists. `hooks/reply-gate.ts` went with the reply hold in 0.5.30, so the `sh` choice it made has nothing left to fix.
- Tests: new `tests/onwindows.test.ts` (28): `detectWindows` signals, the marker commands on both branches (host with no `process.platform`, env only, drive path only, posix) with the argv checked, a REAL `cmd move` and `cmd del` on disk, color read in JS and through findstr or grep by size, a REAL findstr run on a 5 MB file with 1 MB lines, the console helper wired and refused per platform and never typing into a busy console. `tests/color-carry.test.ts` (fake host stats a transcript over the read limit unless `readable`, plus a JS-route case) and `tests/forced-handoff.test.ts` (registered console fallback with no `process.platform`).
- Never run live before this: the Windows branches of the marker commands, the findstr scan on the host, and the console helper through `$.process.run`. After install, read `~/.claude/fast-jev-compaction.log` for `could not delete`, `could not read the session color` and `console fallback`.

## 0.5.30 - 2026-11-24

- Removed the reply hold (the User, 11-24 14:59: "Remove the 10 minute hand over limit."). The handoff `/clear` and the standing clear go at once again, as before 0.5.25: no wait for the last reply to the User to be 10 minutes old.
- Gone with it: the `replyVisibleMinMs` option (plugin.json, README, hooks/README, `HookConfig`), `holdForReply` and its slice sleep (handoff.ts), the stale-file refresh that only the hold used (`refreshes`, `MAX_STALE_REFRESHES`, `GATE_*`), `buildReplyGate` (fast-jev.ts), the standing clear's gate, and `hooks/reply-gate.ts` with its transcript tail reader.
- Tests removed with the code: `tests/reply-gate.test.ts`, the registered-clear hold case in `tests/forced-handoff.test.ts`, the standing-clear hold case in `tests/standing.test.ts`, the `reply-gate.ts` loader case in `tests/host-loader-contract.test.ts`.
- A stored `replyVisibleMinMs` in a user's plugin options is now an unknown key and is ignored.

## 0.5.29 - 2026-11-18

- Fix: a session got the HANDOFF NOW order up to 4 times within a minute while it was writing the file, and the clear was then given up (the User, 11-18 19:44: "Why does the handoff command ... cause eve to do the message 3 times"; 19:46: "Fix it"). Log, session c68f35dd: order 00:42:03Z, `handoff order repeated` at 00:42:49, 00:42:54 and 00:42:58, `handoff not written ... after 4 forced orders; pruning goes on, no clear` at 00:43:05; the file was finished minutes later. 19 repeats and 3 give-ups since 11-12.
- Cause 1: step 2 of `handoffStep` repeated the order at every turn end with an incomplete file. Turn ends come seconds apart while a handover is written (a Stop hook that blocks the stop ends a turn, so does a queued prompt). Now a repeat needs `orderRepeatGraceMs` (new option, default 300000) with no order and no write to the handoff file (`ORDER_REPEAT_GRACE_MS`, the failing `FileCheck` carries the file's mtime). One log line per order says the repeat is waiting.
- Cause 2: every repeat moved `orderAt`, and the file had to be newer than `orderAt`, so a file finished between two repeats read `older than the order` for good. New `HandoffState.firstOrderAt` is the time of the order that opened the cycle (SOON, first NOW, or a stale-file refresh); the file is checked against it (`fileMustBeAfter`) and a repeat never moves it. A record from an older version has none and falls back to `orderAt`.
- A give-up no longer strands the session: a file completed after it is newer than `firstOrderAt`, so the next turn end clears from it.
- Tests: `tests/forced-handoff.test.ts`, three cases with the grace on: the c68f35dd turn-end spacing replayed (one order, the finished file clears), a write restarts the wait and five quiet minutes repeat once, a file dated before a repeat still clears. The harness default is `orderRepeatGraceMs: 0`, so the older repeat tests run as before.

## 0.5.28 - 2026-11-18

- Fix: 0.5.27 did not load either. `readTail` and `readTailHostFs` (reply-gate.ts) receive `$` as `host` and tested `host.fs.read` and `host.fs.stat` for existence before calling them; the loader follows `$` into the function and refuses the read: `compiled line 225 `if (host.fs.read) {`: $.fs.read is used as a value`. Both are now called with no existence test; a host without them throws inside the route's own try and the next route runs.
- `tests/host-loader-contract.test.ts`: new case, every `host.<noun>.<event>` in reply-gate.ts is a call.
- The real gate is outside this repo: `python tools/jev_load_probe.py` (Meta_Orchestrator) starts one throwaway session on the installed version and reads the loader's verdict from its debug log. No session restarts onto a version before it prints `loaded`.

## 0.5.27 - 2026-11-18

- Fix: 0.5.26 did not load. `buildReplyGate` (fast-jev.ts) held the host object in a second name (`const h = $ as ...`), and the Claude Code hooks loader refuses that: `compiled line 561 `const h = $;`: $ itself is bound to a name`. A refused module is no plugin at all. Three sessions restarted onto 0.5.26 at 17:20 (advisor, 8liq, analyst) ran without it until this version. `$` is now cast at each use.
- `tests/host-loader-contract.test.ts`: new case `never binds $ itself to a name` (a variable initializer or an assignment whose value is `$`, casts unwrapped) over every file in hooks/. The 0.5.26 build was merged with this file not in the run; the whole suite is the gate before an install.
- The reply hold of 0.5.26 is otherwise unchanged.

## 0.5.26 - 2026-11-18

- Fix: the 10 minute reply hold was off in every session since 0.5.25 was installed. 11-18 17:03 Pick's reply was cleared 70 s after it was sent (the User, 11-18 17:04). Log `~/.claude/fast-jev-compaction.log`, session 198c03d3, 22:03:21Z: `WARNING handoff: reply gate could not read the transcript ($.process.run(sh) failed to start: ENOENT: Command 'sh' not found ...); the 10 min reply hold is OFF while this fails`, then the clear. 8 sessions logged that line (a943fe12, eb17522a, 39a2fd83, 74e1c914, f406d7c6, 78d6304e, fe981b9d, 198c03d3). Cause: in the plugin host `onWindows()` is false (`globalThis.process` is not usable, and `process.getBuiltinModule` gives no node:fs), so `readTail` chose `sh` on a Windows drive-letter path; the read failed, and 0.5.25 let the clear go at once on a failed read.
- `readTail` (reply-gate.ts) tries node:fs, then the host's own `$.fs.stat` / `$.fs.read` (new `readTailHostFs`, whole file through the host, refused over 256 MB, last 24 MB kept), then a process helper. A drive-letter path picks the hidden PowerShell helper, never `sh`. The error text lists the reason of every route.
- `holdForReply` (handoff.ts, now exported) fails closed: an unreadable tail waits the full `replyVisibleMinMs` counted from the time the clear was asked, logs why (WARNING once per session, a plain line after), re-reads once, and only then clears. A host with no `clock.sleep` still clears (logged), so a broken host never blocks for good.
- The standing clear (hooks/standing.ts) ran no gate in 0.5.25 (the changelog said "not gated"). It now runs `holdForReply` first when the tree has a reply gate. `buildReplyGate` (fast-jev.ts) builds the one gate for the handoff step and the standing arm.
- Not changed (same root cause, found in the same log): `onWindows()` false in the host also makes handoff.ts delete files with `rm -f` (`could not delete ... order.json; rewrote it as order none`), color-carry read the session color with grep (`could not read the session color`), and leaves the 0.5.17 console clear fallback undefined on Windows. Follow-up: one shared Windows check from `$.env.get('OS') === 'Windows_NT'` or a drive-letter home path.
- Tests: `tests/reply-gate.test.ts` (fail closed, blind wait then a readable transcript decides, a long turn of his held like any other, replay of Pick's 11-18 tail with typed, pick-assist and feed words and a peer, readTail without a shell); `tests/standing.test.ts` (the standing clear waits); `tests/forced-handoff.test.ts` 47 to 48: the registered harness now sets `replyVisibleMinMs: 0` (the fake host has no readable transcript, so the fail-closed hold would outlast every test that is about the floor, the clear or its retries; that was the cause of 11 failures in that file and hook.test.ts), and a new test registers with the hold on, a reply to the User 3 min before the forced clear and a readable tail, and shows the clear fires 420 s later on the fake clock, not before the reply is 10 min old.
- Live check not done: whether `$.fs.read` of `~/.claude/projects/...` works in the plugin host. If the host refuses it the gate now holds the full 10 min instead of clearing at once.

## 0.5.25 - 2026-11-16

- A reply to the User now stays visible at least 10 minutes before the plugin's handoff `/clear` (the User, 11-16 16:23: "Your reply wasn't visible for the minimum 10 minutes before the clear"; 16:24: only while he is active and the reply answers him). New option `replyVisibleMinMs` (default 600000, 0 = off). Inside the detached clear work (`holdForReply`, handoff.ts) the plugin reads the tail of the session transcript, finds the newest turn that started with his own message, and sleeps in 30 s slices (`host.clock.sleep`, the hook has returned, the session is free) until that turn's last assistant text is old enough. Each round re-reads, so a new reply to him restarts the clock.
- What counts as his message (new `hooks/reply-gate.ts`, from the `origin` of the `type:"user"` record): `human`, `composer`, `bridge`, and a `feed` or `pick-assist` channel message (same rule as standing.ts; no such record was in any transcript on disk, so that part is copied, not seen). Not his: channel `peer`, `task-notification`, `plugin` (HANDOFF NOW / RESUME), any other origin. `isMeta` records with no origin (stop-hook feedback, system-reminder, image note) belong to the turn they sit in. A `system` `turn_duration` record ends a turn; `[Request interrupted` ends it too.
- After a hold: a turn that is running defers the clear to the next turn end; a prompt newer than the handoff file (a peer message, say, answered during the wait) orders a fresh HANDOFF NOW first, at most 2 times, then the clear uses the file as it is. 20 restarts of the clock end the hold.
- Tail read: `node:fs` in the plugin process (`process.getBuiltinModule`), last 24 MB, 12 ms on a 2.8 MB transcript and 108 ms on a 25.6 MB one. If the host gives no node:fs or it throws, a hidden PowerShell helper (`reply-tail.ps1`, written next to the handoff files; 487 and 635 ms on the same files, same records) on Windows, `tail | grep` elsewhere. If every route fails the clear goes at once, as before 0.5.25, and one `WARNING handoff: reply gate could not read the transcript` line is logged per session.
- Not gated: the standing clear (it already needs the User quiet 60 min).
- Tests: new `tests/reply-gate.test.ts` (21): record classification, 2 min old reply holds to 10 min, 11 min clears at once, peer / task / plugin turns do not count, feed and pick-assist count, a new reply restarts the clock, 0 = off, unreadable transcript never blocks and warns once, stop-hook companion keeps the turn his, hold then clear, stale file then fresh handoff then clear, running turn defers.

## 0.5.24 - 2026-11-12

- Fix: the shared disk log (`~/.claude/fast-jev-compaction.log`) no longer loses lines when sessions log at the same moment. The host has no append call and no exclusive create, so a line was added as read whole file + write whole file. Two processes that read before either wrote made the later write replace the earlier line. 11-12 16:56: six windows restarted at once, and the `module-loaded` receipt of two of them never reached the log although the plugin ran, so the restart check raised a false alarm. Now `appendLog` (fast-jev.ts) and `warmLog` (idle-warm.ts) call one shared `appendDiskLine` (new `hooks/disk-log.ts`): write, wait 25 ms for a writer that read before us to land, read the file back, and if our line is gone read again and append it again. At most 4 writes and no new try after 900 ms, so a turn waits about a second at worst; on giving up the last write is on disk, as before. A read-back that throws stops the loop. The trim (over 512,000 chars, keep the newest half) is part of each write, so a retry trims from what it just read. Line formats are unchanged. Cost: 25 ms per log line.
- Not covered: a loss window shorter than the 25 ms wait but opened after our read-back. The host offers nothing atomic, so this is a bound on the loss, not a lock.
- Tests: `tests/forced-handoff.test.ts` 43 to 47 (two hosts on one disk, second reads before first writes, both receipts survive; always-losing log gives up after 4 writes and has written; failing read-back does not retry; oversized log trims and keeps the new line). `tests/setup.ts` (vitest setupFiles) sets the wait to 0 for the suite, since tests wait on `setImmediate`.

## 0.5.23 - 2026-11-05

- Fix: a standing tree with context under `standing.minTokens` (or an unreadable context) is kept warm again. Until 0.5.22 the timer logged `standing: skip, context N is under minTokens ...; no write, no clear, no ping` and did nothing, so the cache expired and the next prompt rewrote the whole context (7-day study: 143 skips, 135 cold resumes under 150k at about 0.82 USD each). Now `standingStep` returns a ping with the tree's `idleWarmMinutes` spacing (capped at the cold boundary), the ping counts toward `idleWarmMax` for the gap, and the usual `idle warm <n> after <m> min: ...` line is logged; the skip line is not. `idleWarmMinutes` 0 (warm off for the tree) keeps the old skip and no ping. The first check is still at (60 - coldMarginMinutes) min. At or above `minTokens` nothing changes. Trees without standing are untouched.
- Tests: `tests/standing.test.ts` 22 to 28 (under-min ping and spacing, cap then stop, window.json spacing and cap, growth past the minimum, exactly minTokens, non-standing under 150k); the old under-min and "no pings after a clear" tests now state the new rule.

## 0.5.22 - 2026-10-29

- Standing: the resume line now reads "STANDING RESUME: this is a handover. Read <standing.md> first, then do every after-handover step your CLAUDE.md names (required reading included), then answer the prompt." The old line ("read ... first, then answer the prompt") let a tree with required reading after each handover (Strategy_Advisor CLAUDE.md: read docs/REQUIRED_READING.md whole after every handover) answer from standing.md alone.

## 0.5.21 - 2026-10-29

- Standing: the first prompt meta's restart_windows.py types into a relaunched window ("Window restarted by Ryan v2 ...") no longer counts as the User. It arrives with origin composer, so every restart held the standing clear for userQuietMinutes (Pull_Area and Mechanism_Analyst, restarted 17:10, cleared 18:10 instead of about 17:15).

## 0.5.20 - 2026-10-29

- Fix: 0.5.19 did not load in any session. The host loader refused `standing.ts` `await $.store.delete?.(...)` ("$.store.delete is used as a value"), so the whole module was off: no handoff orders, clears or keep-warm from 16:10 local. `standingResumeDone` now overwrites the record with `$.store.set(key, {})` (the reader already ignores a record without `path`).

## 0.5.19 - 2026-10-29

- Standing handover. Per tree, off unless `var/handoffs/window.json` has `"standing": {"enabled": true, "minTokens": 150000, "userQuietMinutes": 60, "coldMarginMinutes": 5}` (read at each arm; a bad `standing` key is warned and ignored, the rest of the file stays). Absent or disabled: behaviour exactly as 0.5.18.
- A standing tree's idle timer first fires at (60 - coldMarginMinutes) min of real idle. With context at or above minTokens: the User spoke inside userQuietMinutes, so a warm ping and a re-check when the quiet is up; else `standing.md` not fresh (older than the last real main-thread activity), so one `$.model.fork` with a fixed prompt writes it (header `session:` / `standing:`, six sections, last line COMPLETE; an invalid text is rejected and logged, the old file stays; the old file is kept as `standing.prev.md`); fresh and complete, no turn running, no handoff order pending, so the session is cleared in-process (`$.command.run clear`, console fallback as the handoff clear) with no prompt submitted. Below minTokens a standing tree does nothing, no ping.
- `standing_clear.json` {old_sid, at, tokens} is written in the old and the new session folder, plus `resumed.json` (so SessionStart skips) and `current_session.json`. The next prompt of any origin in the new session carries the context `STANDING RESUME: read <old standing.md> first, then answer the prompt.` (memory, with a `$.store` record for a reload). No pings after a clear.
- The User's last message time per session: origin `composer`, `bridge`, and the feed / pick-assist channel records. Peer, heartbeat, task notification, schedule and plugin prompts do not count. Kept in memory and persisted to `$.store` (`standing:<sid>`) at each arm.
- New `hooks/standing.ts`; `handoff.ts` exports `clearAvailable`, `waitForNewId`, `handoffBlocking`. Log lines `standing: ...` in the existing plugin log. Tests: `tests/standing.test.ts` (22).

## 0.5.18 - 2026-10-27

- Idle warm timer fixed. The 10-24 log showed two interleaved chains per session tag: the real one (resets at the next turn) and a second one (n=4..9 over hours of turns) whose cache_read grew with the live context. That second chain was a Gap armed under an id that no longer receives events (pre-clear or pre-handoff), whose timer survived and pinged the current conversation until `idleWarmMax`. The `[sid]` tag on the log line is the live id at fire time, which hid it.
- A new session id drops every Gap and timer of the old id (`noteActivity` in `hooks/idle-warm.ts`). A timer that fires under an id that is no longer the live one (checked against both the state and `$.session.id()`) drops its Gap and sends nothing.
- A ping needs a full `idleWarmMinutes` of real idle. The state keeps `lastActive`, set by `prompt.submit`, the turn end and every main-thread `session.append` (`warmTouch`); a child's append and the warm's own turn do not count. A timer that fires early re-arms for the remainder instead of pinging. This also covers a turn started by a delivery (channel message, task notification) with no `prompt.submit`, and a turn longer than the interval.
- A `turn.complete` or dropped submission reads `warmEpoch` before its window lookups and passes it to `warmIdle`; a prompt submitted in between wins the next arm, so no timer is armed for a turn that is already running.
- Tests: `tests/idle-warm.test.ts` 13 to 22 (turn resets, lost-cancel re-arm, append resets, child append ignored, no ping before the interval, ping not counted as activity, clear drops old timers, old-id timer after the id change, epoch race). The idle-warm and tree-warm harnesses fake `Date` so timers see the elapsed time.

## 0.5.17 - 2026-10-26

- Console fallback for a refused handoff clear. Pick Assist d1e9c530 (2026-10-26 12:08) had `$.command.run('clear')` refused twice with "the session was stopped and nobody has sent input since". The User only talks to Pick through channels (voice, phone), which do not count as typed input, so the 0.5.16 retries could never succeed.
- When the clear fails with that refusal (`isStoppedRefusal`: "session was stopped/interrupted", "nobody has sent input"), the plugin types `/clear` + Enter into the session's own console (Windows only, `hooks/console-clear.ts`). Other clear errors and other platforms keep the 0.5.16 retry and cooldown path.
- The console work is a PowerShell helper (`console-clear.ps1`, written next to the handoff files, started hidden through `$.process.run`): it finds the claude.exe pid from `~/.claude/sessions/<pid>.json` by session id, AttachConsole, reads the visible rows, and later writes the key records with WriteConsoleInputW. It runs as a child, so its FreeConsole/AttachConsole never touch the plugin's stdio.
- It types only when `screenVerdict` says idle with an empty prompt box: no "esc to interrupt" on screen, a prompt row framed by rules, nothing after the marker. The helper re-checks the same rules just before writing. A busy session, typed text or a dialog waits for the next turn's retry (counts as one failed attempt, reason in the log line).
- After typing, the session id is polled for up to 30 s. Changed: one log line `handoff clear via console fallback (pid N)`, then the normal path (copy files, resume order). Unchanged or any helper error: the `handoff clear failed` line carries `; console fallback: <text>` and the usual retry/cooldown applies.
- Tests: `tests/console-clear.test.ts` (refusal match, idle/empty-prompt fixtures from live screens, helper call order with mocked `process.run`, fallback wiring, other errors never use the console), one registered-wiring test in `tests/forced-handoff.test.ts`. Version bumped everywhere (HOOK_ID `0.5.17`).

## 0.5.16 - 2026-10-23

- The plugin no longer gives up on the handoff clear for good. Meta session cc4dac21 (2026-10-23) had three `command.run('clear')` calls refused by the host, then `clearFailures` stayed at 3, step 1 of `handoffStep` was skipped on every later turn and the order marker was deleted. Only a restart ended it.
- Up to 3 attempts per burst, as before. `lastClearFailAt` is recorded; once `CLEAR_RETRY_COOLDOWN_MS` (10 minutes) has passed, the next turn end starts a new burst, forever, until the clear works.
- A prompt with origin `composer` or `bridge` (a person) resets the failure count (`resetClearFailures`). Peer, task and plugin prompts do not.
- The `handoff clear failed (attempt n of 3)` log line now carries the thrown error text (first 200 characters).
- The order marker is kept at the cap, so the pending clear stays visible.
- Tests: `tests/forced-handoff.test.ts` (error text, cooldown retry, person reset, marker). Version bumped everywhere (HOOK_ID `0.5.16`).

## 0.5.15 - 2026-10-22

- Handoff root drift fixed. Session 15635d41 (Mechanism_Analyst, 2026-10-22 05:37) captured `F:\REPS2\Mechanism_Analyst\var\handoffs` as its root, so the plugin expected `...\var\handoffs\var/handoffs\<sid>\latest.md` while the session wrote `...\var\handoffs\<sid>\latest.md`. COMPLETE was never seen, no clear, idle at ~270k with the force limit at 300k.
- The root never sits inside `<x>/var/handoffs`: `normalizeRoot` in `hooks/handoff.ts` cuts any captured or stored root back to `<x>` (any depth, both separators, any case). A first capture also prefers the tree root, the nearest ancestor holding `var/handoffs` or `.git` (`findTreeRoot`, probed through `$.fs.exists`).
- A clear that changes the id now hands the old id's root to the new id even when the new id already captured a drifted one (before, an existing root won).
- A bad root already stored in memory is healed on every read, so a live session recovers without a new session.
- Defence in depth: when the expected `latest.md` is missing or older than the order, `<treeRoot>/var/handoffs/<sid>/latest.md` is accepted if its header names the session and its last line is COMPLETE. One log line: `handoff: expected <path> is <reason>; accepting the complete <path> (session <id8>) from the tree root`. The clear, `resumed.json` and the resume order then use that file.
- Tests: `tests/root-drift.test.ts`. Version bumped everywhere (HOOK_ID `0.5.15`).

## 0.5.14 - 2026-10-20

- Order delivery no longer rests on `$.prompt.submit` alone. Session 21687c6d (Meta, 2026-10-20 12:07Z to 12:25Z) got four HANDOFF NOW orders logged and never saw one: no queue enqueue after any of them, no error, no log line. The order was queued with `void work()` and the submit result was never read.
- The pending order text is kept per session (`pendingOrders` in `hooks/handoff.ts`, cleared with the order marker). The `prompt.submit` hook attaches it as `context` to the next prompt that enters from any origin (user, peer, notification), once per order text, unless the session already holds that text. Log line: `handoff order carried as context on the next prompt (<origin>)`.
- New log lines for the own submit: `handoff order submit returned after N ms`, `handoff order submit DROPPED after N ms (<reason>)`, `handoff order not submitted: session id is X, order was for Y`. A submit that never resolves leaves none of them, which is itself the signal.
- Tests: `tests/forced-handoff.test.ts` (0.5.14 describe). Version bumped everywhere (HOOK_ID `0.5.14`).

## 0.5.13 - 2026-10-16

- Color carry follows the session chain. 0.5.9 read the `agent-color` record only from the transcript being cleared; once one clear ran without carry (0.5.8), every later transcript had no record and the color stayed blank for good. Now, when the cleared session's transcript has none, the walk goes back through previous ids (`<handoffDir>/current_session.json`, then `log.jsonl` `resumed` rows: `previous_id`, or the folder of the resume `file` on older rows) up to 10 transcripts and stops at the newest one with a record. A `/color` record in the current session always wins.
- Cache `<handoffDir>/color.json` `{agentColor, from_session, at}` is written whenever a transcript record is read, and used only when no transcript of the chain has one.
- Log lines: `no agent-color record in <n> transcripts of the chain` (grep/findstr exit 1 is no record) is separate from `could not read the session color from the transcript (<k> read errors ...)`. A read error on one hop does not stop the walk. Existing `carried` and `not carried` lines unchanged.
- Older transcripts that no longer exist are skipped, not errors. Code: `resolveColor` in `hooks/color-carry.ts`, called from `hooks/handoff.ts`. Tests in `tests/color-carry.test.ts`.

## 0.5.12 - 2026-10-16

- Per-tree idle warm. `<handoffDir>/window.json` may carry `idleWarmMinutes` and `idleWarmMax`. They override the user-level options for that tree only, so the warm can be switched on for one orchestrator, measured, and later rotated as a trial arm. Missing key: the option. `idleWarmMinutes: 0`: off for the tree even if the option is on. A non-number or negative value rejects the whole file (one warning per mtime, options stay), same as `handoffAt`. `idleWarmMax: 0` means the option value.
- The warm now takes the effective per-tree interval and cap at each arm (main `turn.complete`, dropped submission), through the same mtime cache as the handoff window. Editing window.json needs no restart. `createWarmState()` has no global on/off any more; `warmIdle` takes `minutes` and `max`. The timer and the `idle warm <n> after <m> min: cache_read ...` log line are unchanged.
- The window-change log line names the warm when the file has a warm key: `handoff window 150000/200000, idle warm 50 min x2 from window.json (arm block1 W1 S1)`.
- Cost: one window.json stat per main turn end even with the option off (the handoff path already did one).
- Tests: `tests/tree-warm.test.ts`. Version bumped everywhere (HOOK_ID now `fast-jev-compaction@0.5.12/forced-handoff-floor`).

## 0.5.11 - 2026-10-16

- Add an opt-in idle cache warm (`idleWarmMinutes`, default 0 = off; `idleWarmMax`, default 6). After each main-thread turn.complete one `$.clock.after` timer per session is armed. When it fires and no turn runs, one `$.model.fork` with the prompt `Reply with the single word ok.` is sent, which reads the main conversation's cached prefix and resets its TTL; then it re-arms, up to `idleWarmMax` warms per gap. A new prompt.submit or turn.complete cancels and re-arms. Never submits a prompt, never warms during a turn, never throws out of the timer.
- Each warm logs one line to `~/.claude/fast-jev-compaction.log`: `[sid8] idle warm 2 after 100 min: cache_read 212345, cache_write 41, out 3` (usage from the fork result). A null or failing fork logs one `idle warm <n> failed ...` line and stops warming for that gap.
- Code in `hooks/idle-warm.ts`; wired into the prompt.submit and turn.complete handlers. Tests: `tests/idle-warm.test.ts`. Whether the fork's prefix really equals the main one (a live cache_read near the context size on the first warm) is a deployment check. See `docs/reports/JEV_WARM_NOTEBOOK_20261016.md`.

## 0.5.10 - 2026-10-16

- Add a per-tree handoff window override: `<handoffDir>/window.json` `{"handoffAt", "handoffForceAt", "arm", "until"}`. User-level `pluginConfigs` give one value to every tree; this file lets each tree run its own window. Read live at each turn completion and ratio miss, cached by mtime (one stat when unchanged). Missing file: options win, silent. Malformed JSON, non-numbers or `handoffAt` under 50000: ignored, one warning per mtime. `handoffForceAt` is still raised to `handoffAt` if lower.
- Log a change of the effective window once in `~/.claude/fast-jev-compaction.log` (`handoff window 200000/250000 from window.json (arm B)`, `handoff window back to options 250000/300000`). SOON and NOW log lines and `order.json` now carry the window and its source, for trial readouts.
- Tests: `tests/handoff-window.test.ts` (absent, valid, malformed, non-number, below floor, force below at, mtime cache, change logged once). Installation and a live handoff under a window file remain deployment checks.

## 0.5.9 - 2026-10-15

- Keep the `/color` session color across the handoff clear. Before the clear the newest `agent-color` record is read from the outgoing transcript (streamed through grep/findstr, never loaded whole); after the clear and before HANDOFF RESUME it is re-applied with `/color <name>` through `$.command.run`. If the host lists no `color` command or the run fails, only a log line: the new transcript is never rewritten for a color (`$.fs.write` replaces the whole file). No record means nothing is done. A read error is logged and the handoff goes on.

## 0.5.8 - 2026-10-15

- A reduction strictly below `minReductionRatio` now retains history and pins and immediately forces a written HANDOFF NOW. Exactly 25% passes at the default floor. This also covers unscored recovery and late-delivery ratio misses. Missing, changed or unreadable `DISABLE_AUTO_COMPACT` never restores built-in summary fallback. The older release notes below describe their historical behavior, not the 0.5.8 policy.
- Persist the ratio force reason and bounded order budget in session handoff state. Start NOW without waiting for 250k/300k token thresholds, even when usage is unavailable. Orders and markers name the real reason and actual tokens or `null`, not a synthetic count. Callback reload and lost flag/usage reads continue the cycle. Compaction callbacks only request an order; later non-aborted main-loop completions validate and clear. Deduplicate ratio-force notices and avoid a duplicate NOW on the first completion.
- Keep token triggers, target fitting, skip-on-Jev-error behavior and token-threshold handoffs opt-in through `DISABLE_AUTO_COMPACT=1`. Other sessions keep percent triggers and unscored recovery on Jev errors. Neither policy calls the built-in summary. The launcher flag is still needed to disable the harness's independent automatic compaction.
- Require a fresh regular latest.md, the exact session id in its first 10 lines, a final `COMPLETE` line and stable mtime/size across each read. Recheck the file after the detached delay and immediately before clear, including changes during resumed-marker and log writes. Recheck the session id after the final file validation so a session switch during its read/stat cannot clear a new session. Reject a replaced version even if it is complete. Deduplicate concurrent clear capability lookups and fail closed when clear is unavailable. Orders repeat at most 3 times; clear failures stop at 3 attempts. No RESUME without a successful clear. A written `resumed.json` alone is not proof that clear happened.
- Write a disk-only callback `module-loaded` receipt with source build `fast-jev-compaction@0.5.8/forced-handoff-floor`, full session id and classified launcher flag (`1`, `unset`, `other`, `unreadable`). Write once per session per callback registration, not from manifest inspection. Never log raw environment values or error bodies.
- Validation: 238 tests across 16 files, library/hook typechecks, build and diff check passed. The final-session read/stat regressions both failed before the guard and pass with it. Native scanner validation, installation, fresh runtime receipts and live clear/resume acceptance were not run in this worktree; the parent owns those checks.

## 0.5.7 - 2026-10-15

- Recognize Claude Code 2.1.300 `session.append` API text blocks (`type: "text"`) as well as legacy projected text (`kind: "text"`). The live 10:06 cut exposed ordinary text being mislabeled opaque and skipped by the observer ledger. Text blocks now join verbatim and become pinned deliveries, including arrivals during scoring and child scopes. Explicit opaque kinds and missing/non-string text remain excluded.
- Keep routine opaque-block receipts in `~/.claude/fast-jev-compaction.log` only. Cut summaries, applied measurements, errors and fidelity-gap warnings remain visible. These `ui.log` receipts were visible transcript diagnostics, not model context; the 0.5.6 bookkeeping reduction remains intact.
- Validation: 203 tests, library/hook typechecks, build and Claude plugin scanner validation. New registered-hook regressions replay the observed block shape with hidden projected/API deliveries, durable pin writes, a cold restart and a child arrival during scoring. Installation and a fresh native loader receipt remain deployment checks; this release does not rewrite running-session history.

## 0.5.6 - 2026-10-15

- Collapse exact standalone tool-removal notices into one history-level warning; keep detailed counts in compaction decisions/logs. Repeated passes are idempotent. User text, quoted/fenced examples and tool payloads are untouched.
- Move delivery pin fingerprints and occurrences from model-visible user messages to the host's durable plugin store, keyed by session id and child id. Migrate legacy inline rows on the next accepted cut. Verify writes, preserve input fingerprints if the host rejects a prepared cut, and retain inline pins when storage fails or deliveries arrive during final persistence/diagnostics. Missing or corrupt records conservatively protect user text; tool-only result rows remain eligible.
- Shorten only the exact generated background-notification preamble. Known human prompts stay verbatim, including raw pasted warning examples, across restart. Legacy pins without origin shorten only warning-only fragments after recognized prefixes. Event bodies and ordering remain intact; ambiguous prefixes stay unchanged.
- Measure reduction against the original incoming history, including removed bookkeeping. Session id changes isolate the in-memory delivery ledger as well as durable pins.
- Validation: 194 tests, library/hook typechecks, build, plugin loader validation. Offline keep-all replay of Pick Assist's current parent chain saved an estimated 18,392 visible tokens without changing user payload/order or tools/results beyond the existing host projection. A live accepted compaction is still the runtime acceptance check.

## 0.5.5 - 2026-10-14
- Pending-order marker. A SOON or NOW handoff order writes `<handoffDir>/<sid>/order.json` (`order`, `ts`, `tokens`, `limit`, `attempt`) atomically, rewrites it on each repeated order, and removes it when the cycle ends (after the clear, in the old and new id folders, before the resume submit; also on give-up, blocked clear, third clear failure). Lets the trees' Stop hooks stand down before `latest.md` exists (seen live 20:30: HANDOFF NOW at 300,664 waited behind a Stop-hook refusal). The order log line names the marker path. Rename and delete go through `$.process.run`; without it the marker is written in place and removal leaves `{"order":"none"}`.

## 0.5.4 - 2026-10-14
- The handoff root no longer follows the Bash tool's working directory. A relative `handoffDir` and `handoffSkillPath` resolve once per session id against the cwd seen on that session's first event (the launch cwd) and the root is cached; a later `cd` by the model cannot move `latest.md`, `resumed.json`, `current_session.json`, `prune_skipped.json` or the skill path (seen live 19:32: `var/handoffs/var/handoffs/...`, order re-issued). A changed cwd logs one line per session (`handoff root stays at the captured cwd ...`). A new session id captures again, except after the plugin's own handoff clear: there the new id inherits the old id's root, so a `cd` before the clear cannot move the resume. Absolute values are unchanged.

## 0.5.3 - 2026-10-14
- `handoffDir` resolves against the session working directory when relative (same rule as `handoffSkillPath`), through one helper, `resolveAgainstCwd`; an absolute value is used as given. Default is now `var/handoffs`, so each tree keeps its own store (one writer per store). Applies to the skip marker, the handoff step, `current_session.json` and the resumed/latest files.

## 0.5.2 - 2026-10-14
- Jev unavailable (transport or key failure): a hybrid session no longer cuts blind through the transcript recovery path; it skips, writes `prune_skipped.json` with the reason, counts `jev_unavailable`, and the handoff machine takes over at `handoffAt` and `handoffForceAt` (the User, 18:59). Other sessions keep the 0.4.4 recovery cut.

## 0.5.1 - 2026-10-14
- The session gate also covers the post-cut target loop: `targetVisibleTokens` applies only in a hybrid session (`DISABLE_AUTO_COMPACT=1`); every other session keeps the 0.4.4 cut at `keepThreshold`, so one options block can serve all sessions.

## 0.5.0 - 2026-10-14
- Session gate: the hybrid (token trigger, skip on a ratio miss, handoff orders, clear and resume) runs only where the launcher set `DISABLE_AUTO_COMPACT=1`; any other session keeps the 0.4.4 behaviour (percent trigger, ratio miss falls through to the harness summary, no handoff). One plugin cache serves all sessions; this keeps the test to the one session that opted in.

Source: the User, 17:54 to 18:22 local: the Claude Code auto-compaction is off
entirely (`DISABLE_AUTO_COMPACT=1` on the launcher); the plugin alone manages
context. Jev prunes tool calls from a token trigger, aims at a real post-cut
size, and when the unprunable context reaches two thresholds it orders the
session to write a handoff, forces it, clears the session itself and resumes it
from the handoff file. The built-in summary is never requested.

- `compactAtTokens` (default 160000): the `turn.complete` trigger compares
  `context.tokens` against it. `compactAtPercent` still applies when it is unset.
- `targetVisibleTokens` (default 64000): after the first pass the cut is re-decided
  from the cached Jev probabilities with a rising `keepThreshold` (0.05 steps,
  then 1.0001) until the visible estimate is at or under the target; at the
  floor, `replyMinChars` and `injectedMinChars` are halved once (floors 1100 and
  200). No new Jev request. The estimate counts visible messages only; the real
  context after a prune is the target plus the system and tool prefix.
- A reduction-ratio miss returns `{ skip }` and writes
  `<handoffDir>/<sessionId>/prune_skipped.json`. The `fallback(next)` path is
  removed; `compactTranscript` stays as the offline recovery on transport failure.
- A 32000-token hysteresis after any prune or skip stops a re-fire every turn.
- Handoff orders (`hooks/handoff.ts`), state per session in `$.store`:
  at `handoffAt` (default 250000) of unprunable context, once per 50000 of further
  growth, `$.prompt.submit` of a HANDOFF SOON order; at `handoffForceAt` (default
  300000) a HANDOFF NOW order, repeated at most three more times. When
  `<handoffDir>/<sessionId>/latest.md` exists, names this session in its header,
  ends with `COMPLETE` and is newer than the order: `resumed.json` is written,
  `$.command.run({ command: "clear" })` runs (gated on `$.command.list()`
  containing `clear`), and a HANDOFF RESUME order is submitted. After the clear
  the session id is read again; a changed id gets copies of `latest.md` and
  `resumed.json`, and `current_session.json` records `{ id, previous_id, at }`
  in both cases. Never a clear without a complete file.
- `handoffDir` (absolute) and `handoffSkillPath` (default `docs/HANDOFF_SKILL.md`
  against the session cwd) are quoted in the orders.
- Every log and notify line carries the session id's first 8 characters.
- Six `userConfig` entries in `.claude-plugin/plugin.json`; the harness side
  (`tools/hybrid_enable.py` in the Meta_Orchestrator repo) writes the first five.
- Live checks owed before the User starts it: `$.command.run` with `clear` and
  `$.prompt.submit` from a detached call after `turn.complete`, and whether the
  session id survives the clear.

## 0.4.4 - 2026-10-14

Source: the User, 15:23 local: "I need jev to actually work everytime. The only
time it should not work is if the reduction ratio is not met." Ryan's 15:19
cut hit repeated projected prompts without an intervening text/tool anchor.
This order supersedes the 0.4.1 fallback exceptions below.

- API chronology no longer throws FidelityError. Repeated prompts consume
  projected occurrences in order. Missing anchors use transcript order, with
  a log note. Conflicting text order preserves visible prompts and recovers
  only uncovered spans. Snapshot anchors select occurrences, not first text.
- Missing observer content/anchors retain observable transcript text and log
  the gap. Unknown media is still not representable by handleless rows.
- Request/key/result/preparation failures produce unscored transcript recovery:
  all text and calls stay, eligible old results use the existing truncation and
  evidence notes. Late deliveries stay pinned. The actual replacement,
  including provenance, passes the reduction gate. Only a missed ratio invokes
  the built-in summary. Depth continues to warn only.
- Notifications write disk first; UI failures cannot lose a prepared cut.
  Every recovery reason goes to ~/.claude/fast-jev-compaction.log.
- A host without session.compact never receives a plugin request to core.
  It logs incompatibility. The public host contract has no alternate transcript
  installer; compatible-runtime installation stays with Ryan's existing release
  queue 0f83ff731638. No fabricated setter or direct JSONL write is introduced.
- All 17 new gates fail on pinned 38b2b03 and pass here. The full suite passes
  122/122, with library/hook typechecks, build and actual Claude manifest/hook
  scanner validation. Reproduction:
  `python tools/jev_044_gates.py`. Existing fidelity gates explicitly isolate
  retention/order from the newly restored reduction policy.

## 0.4.3 - 2026-10-14

Source: the User, 2026-10-14 11:58, on Ryan v2's 11:57 compaction (351,458 to 8,330 tokens, 69 s,
built-in summary, no toast, no log line): "It seems like it triggered the normal compact. Check why
jev didn't trigger."

- 0.4.2 never loaded. Claude Code 2.1.299's hooks loader refused the module at the new
  `$.ui.toast?.(text, ...)` call: "$.ui.toast is used as a value (an event of $ bound, passed or
  read) instead of called; $ is always spelled $.noun.event(...) at the call site". A refused module
  is no plugin: every compaction in both sessions since the 11:52 restarts went to the built-in
  summarizer with nothing on screen and nothing on disk. Found with `claude -p ... --debug-file`.
- `notify` calls `$.ui.toast(...)` plainly again; `appendLog` no longer reads `$.fs` or `$.env` as
  values (a missing noun throws inside its own try and is swallowed, as before).
- `tests/host-loader-contract.test.ts`: the hook sources may never optional-chain a call on an
  event of `$` or read one as a value outside the 0.4.1 cast-then-call; fails before an install can.
- Install receipt for any version from here on: a headless `claude -p` run with `--debug-file` must
  show `hooks module fast-jev-compaction@fast-jev-compaction loaded`, never `failed to load`.

## 0.4.2 - 2026-10-14

Source: the User, 2026-10-14 11:40, on Ryan v2's 11:08 compaction, which fell to the built-in summary
with the toast "fallback to built-in summary (delivery contains opaque blocks unsupported by
handleless SessionMessage)": "fix this now", and 11:38 "I also need the jev toast to be put on disk
correctly so the next restart catches it."

- An opaque block inside a delivery (an image or any non-text attachment block) or inside a legacy
  API history user row is no longer an unreconstructable delivery. The host's own projection carries
  such a row as its text blocks joined; Jev now carries exactly that, pins it as before, and writes a
  fidelity note naming the dropped block kinds. A delivery with no text at all pins nothing. The cut
  proceeds; no built-in summary is spent on it. `unreconstructable_delivery` remains for an observer
  that omitted the content blocks and for unprovable chronology.
- Every toast and `$.ui.log` line (fallback reasons, fidelity notes, warnings, the kept-cut line,
  applied-compaction measurements, decision logs) is also appended to
  `~/.claude/fast-jev-compaction.log` (USERPROFILE, then HOME), ISO timestamp first, through the
  host's `fs` (read, trim to the newest 256k characters once over 512k, write). A log that cannot be
  written never changes a cut.
- Tests: the two 0.4.1 opaque-row tests are replaced by their 0.4.2 counterparts (noted and kept, no
  fallback), one test for the log file and one for a failing log write; the core-required contract test
  uses an omitted-content delivery, the row class that still requires core.

## 0.4.1 - 2026-10-14

Source for every change below: Ryan v2's **Jev fork 0.4.1 fidelity brief**, written
2026-10-14 08:05, and the User's 06:43 ruling, "You are not turning off Jev."

- Brief 1: `maxPostCompactTokens` defaults to 0 and only warns. The kept toast
  reports estimated visible post-cut tokens against the target at any value;
  size never triggers summary. Low reduction also warns instead of summarizing
  (brief 5's exhaustive fallback policy).
- Brief 2: pin accepted mid-turn prompts/context and rendered `session.append`
  deliveries verbatim. Observe all append UUIDs for chronology, correlate queued
  deliveries with provisional submissions, and restore arrivals during scoring.
  Track pinned identities across cuts; repeated equal instructions remain distinct.
  One separate fingerprint/occurrence provenance row survives plugin reload and
  resume while each original instruction row remains verbatim.
- Brief 3: first startup/resume cut uses Jev's handleless rebuild. Recover known
  historical hidden text through 2.1.299's bounded API-tail view, aligned to visible
  text/tool anchors. Never substitute the bounded tail for the older history.
- Brief 4: subagent compactions use Jev; select child API history and isolate its
  observer ledger. Queued rendered attachments are passed verbatim and unscored.
  Main-session usage requests remain protected from child completions.
- Brief 5: one retry for transport failures as well as the existing retryable
  HTTP statuses. Classify request failures and invalid/missing/out-of-range engine
  results separately; report a missing compaction event. Every controlled fallback
  toasts its reason; opt-in decision logs count reasons cumulatively. Local budget
  failures veto the cut rather than summarizing. Brief 2's explicit one-cut
  exception covers known opaque/unobservable deliveries or unprovable chronology;
  2.1.299's handleless schema cannot carry opaque media blocks.
- Brief 6: retain precompute veto, handleless fresh IDs/parents, sibling/result
  merging, Unicode pair safety, evidence markers, opt-in kept/dropped probability
  logging and usage guard. All 70 existing tests remain; adapted fallback tests
  state the brief's reason inline. Add pinned-before 4cc723a fidelity regressions.

No engine/model change or keepThreshold 0.7 settings-trial change. Plugin,
marketplace, npm package and lockfile root versions are 0.4.1.

## 0.4.0 - 2026-10-14

- Veto speculative `precompute` Jev calls without a toast. Actual cuts say
  `kept ...; replacement prepared`; plugin-triggered applied cuts log the engine's token measurement.
  Evidence: the held cache study reports 265 trading / 441 Pick no-drop toasts;
  our same-input recount finds 261 / 440, with only one compact boundary among
  701 windows. Current 2.1.299 runtime keeps precompute results for later and may
  discard them. Historical triggers were not recorded, so this does not attribute
  every historical event to precompute.
- Rebuild every retained row without its opaque handle. This prevents reused
  assistant IDs multiplying across resumes (#129) and stale parents bypassing
  the compact boundary (#145). Evidence: current runtime restores both through
  handles; our full raw-transcript read finds 20,103 / 19,966 globally unique
  assistant IDs reused across boundary segments (153,422 / 115,832 repeated
  identity/segment occurrences). First cut after startup uses the built-in
  summary to establish a baseline for legacy resumed histories.
- Combine consecutive assistant rows and adjacent pure result rows when rebuilding.
  Evidence: #137's partial parallel-call edit split one response and triggered
  the host's missing-result repair. Tests retain both adjacent results after
  changing only one sibling, and replay four compact/resume rounds.
- Protect queued prompts and hidden deliveries with the built-in path. Observe
  successful mid-turn prompt submissions and 2.1.299 `session.append` deliveries,
  including internal task notifications, passing the original event to core.
  Evidence: #133 and the runtime's compaction projection omit queued attachments.
  Unsupported observer hosts stay on built-in summary. No shared plugin store
  or guessed instruction chronology is introduced.
- Score recognized injected blocks and old long assistant replies; retain removal
  markers, typed user text and skill arguments. Supply bounded text previews to
  Jev and preserve fenced examples. Evidence: #140 and our study's 98 percent
  reductions with a 168k post-cut median. Adapted from danexplore's upstream
  [PR 141](https://github.com/tamaratran/fast-jev-compaction/pull/141), with stricter
  classification, Unicode safety and the fork's bounded request concurrency.
  A candidate whose bounded preview disappears during state fitting is kept
  unscored (`unrepresented`), rather than asking Jev about invisible evidence.
- Report estimated visible post-cut tokens and fall back above the new 80k target
  (`maxPostCompactTokens`, 0 disables it). Count tool output once, excluding mirrored
  assistant summaries, and rebuild hidden blocks out of accepted replacements.
  Evidence: the study found character reductions did not predict post-cut size.
  This is a conversation estimate, excluding the system/tool prefix.
- Preserve surrogate pairs when slicing and repair malformed source strings before
  JSON serialization. Evidence: #128 identifies split emoji in state and result
  cuts, rejected by Jev as invalid Unicode. Reject out-of-range probabilities too.
- Add a short supporting-evidence marker for fully removed tool calls. Evidence:
  #123 reports an earlier grounded answer being mistaken for fabrication after
  its supporting calls disappeared.
- Make decision logging opt-in (`logDecisions`, false). Include kept calls' two
  probabilities and text scores when enabled; never log arbitrary tool output or
  transport error details. Evidence: PR 146's repeated multi-line diagnostic
  output and the study's inability to size the keepThreshold trial. Adapted from
  [chen-QaQ's PR 146](https://github.com/tamaratran/fast-jev-compaction/pull/146).
- Guard overlapping main-turn completions after their asynchronous usage reads;
  subagent completions cannot compact the main session. Evidence: code review
  found the previous global flag was checked only before the usage await.

The user's 0.7 keepThreshold trial remains a settings choice and is unchanged.
All release metadata (plugin, marketplace, npm package and lockfile root) is 0.4.0.
