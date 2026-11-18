# NOTEBOOK replyhold 2026-11-18 (tk-ht1fwb, branch fix/reply-hold-channel-words, 0.5.26)

Model: Sonnet 5.5. Stopped at the 60 call cap, work is a WIP commit, NOT finished (see Stage).

## Cause (evidence)
Candidate 3. The gate ran and failed open. ~/.claude/fast-jev-compaction.log, session tag 198c03d3 (Pick's session before the clear; c1504e0c is the id AFTER the clear, "session id CHANGED at the clear (198c03d3 -> c1504e0c)"):
- 22:02:13Z handoff order NOW at ~362315 tokens
- 22:03:21.219Z "WARNING handoff: reply gate could not read the transcript ($.process.run(sh) failed to start: ENOENT: Command 'sh' not found ...); the 10 min reply hold is OFF while this fails"
- 22:03:21.273Z handoff complete ... clearing
Pick's transcript tail: his words at 22:00:15 were `origin {"kind":"human"}` (typed), not a channel message. The reply was 22:02:11, the clear 22:03:21 = 70 s later. So candidate 1 is NOT the cause (classifyUser already counted feed and pick-assist channel words in 0.5.25). Candidate 2 not the cause: the log line says 0.5.25 loaded in that session. Candidate 4: standing.ts has its own clear with no gate (found, fixed in this commit).
Why the read failed: in the plugin host `globalThis.process` is not usable, so `onWindows()` is false (also `process.getBuiltinModule` gives no node:fs). readTail then picked `sh`, which does not exist on this Windows host. The same false onWindows() also makes handoff.ts use `rm -f` (log: "could not delete ... order.json; rewrote it as order none"), color-carry use grep (log: "could not read the session color ... read errors") and leaves consoleClear (0.5.17) undefined on Windows. Not changed here (would enable never-run behavior); one-line follow-up: detect Windows from `$.env.get('OS') === 'Windows_NT'` or a drive-letter home path, in one shared helper.
Count: `grep -c "reply hold is OFF"` = 8 lines, one per session (WARNING is once per session): a943fe12 (11-17 12:51Z), eb17522a (11-17 17:02Z), 39a2fd83 (11-18 00:02Z), 74e1c914 (14:19Z), f406d7c6 (15:01Z), 78d6304e (16:37Z), fe981b9d (18:31Z), 198c03d3 (22:03Z). The hold was off for every handover clear of those sessions since 0.5.25 was installed. (The coordinator cited line 2306; in this file the line is 2578.)

## Changed (edited, partly run)
- hooks/reply-gate.ts: readTail now tries node:fs, then the host's own `$.fs.stat/read` (new readTailHostFs, 256 MB cap, last 24 MB kept), then a process helper; a drive-letter path picks powershell, never sh; error lists every route's reason. HIS_ACTIVE_MS = 30 min, TailView.hisAt, gateWait(view, now, minMs, activeMs): no hold when his last own message is older than 30 min (0.5.25 defined no "active" test).
- hooks/handoff.ts: holdForReply exported, fails closed: unreadable tail waits minMs from the time it was asked, logs why (WARNING once per session, plain line after), re-reads once, then clears. GateOutcome exported.
- hooks/standing.ts: standingClear runs holdForReply first when arm.replyGate is set (the standing clear had no gate in 0.5.25).
- hooks/fast-jev.ts: buildReplyGate shared by the handoff step and the standing arm; HOOK_ID 0.5.26.
- Version 0.5.26: plugin.json, marketplace.json, package.json, README 274/317, hooks/README 187, fast-jev.ts HOOK_ID, tests/forced-handoff.test.ts 438.
- Tests: tests/reply-gate.test.ts (fail-closed, blind wait then readable, not active, Pick 11-18 tail replay with typed, pick-assist and feed words and a peer, readTail without shell), tests/standing.test.ts (standing clear gate).

## Test state
Run once (vitest run tests/reply-gate.test.ts tests/standing.test.ts): 58 passed, 2 failed.
- reply-gate "after the blind wait a readable transcript decides": failed because my fake read moved the reply time each call. Edit made (reply time fixed, file refreshed inside read); the leftover `r.put(r.latest, r.good, at + 600)` line after `r.step(...)` is harmless. NOT re-run.
- standing "0.5.26 the standing clear waits": failed on `toContain('WARNING handoff: reply gate could not read the transcript')`: the once-per-module WARNING was already spent by an earlier test, the log had the plain line and the hold from 11:05 to 11:15 (10 min), which is the behavior wanted. The assertion fix (drop "WARNING handoff: ") was denied by the call cap, so this test still FAILS in this commit.
- Not run at all: forced-handoff, hook, console-clear, idle-warm tests; `npm run typecheck` (tsc, incl. hooks config; buildReplyGate typing unchecked).

## 2026-11-18 17:2x finish agent (Sonnet 5.5)
- Finding: the 11 failures were the fakes, not a product bug. In tests/forced-handoff.test.ts the fake host (harness, line 47-88) has no file at the transcript path (`fs.read` throws 'missing', `process.run` exits 1), so readTail returns ok:false. 0.5.25 holdForReply returned `go` at once on that (old handoff.ts line ~311); 0.5.26 holds the full replyVisibleMinMs (hooks/handoff.ts holdForReply, blind wait through sleepSliced). The fake `clock.sleep` waits for `flush()` per 30 s slice, so 20 slices never finish and `$.command.run` is never called: "spy called 0 times". hook.test.ts and the stopped-session 0.5.17 case fail the same way.
- Fix: harness defaults `replyVisibleMinMs: 0` with a comment; the product gate is unchanged and fail-closed. After it 272 of 273 passed, the one failure was my new test (turn left open without turn_duration -> clear deferred, correct product behaviour; added a turn_duration record) and a 1 ms clock tick in the sleep total (range assertion).
- New test: '0.5.26 the registered clear waits until the reply to the User is 10 min old (readable tail, fake clock)': reply 3 min old, readable tail through the fake $.fs, clear fires 420 s later, not before.
- standing.test.ts assertion fix was already in the tree.
- Live probe (read-only): reply-gate readTail on the newest real transcript of the meta project, node:fs route and host-$.fs route (node:fs skipped, process.run throws if used): both 74 records, same anchorAt 2026-11-18T19:49:16Z.
- Result: 12 files / 273 tests pass, typecheck exit 0. CHANGELOG, README step 6, hooks/README written.
- Not verified: `$.fs.read` of the transcript path inside the real plugin host (outside the tree). Seen in the wider onWindows defect: nothing new.

## 2026-11-18 17:3x review (meta orchestrator)
- Removed the 30 min "active" window (HIS_ACTIVE_MS, TailView.hisAt, gateWait's activeMs): it switched the hold off for a reply that ends a turn of his longer than 30 min, the same early clear this fix is for. The anchor (newest turn his own message started) is the "active there" test, as in 0.5.25. Its test now asserts the long turn is held.

## Stage / left to do (older, from the capped agent; items 1-3 now done)
1. tests/standing.test.ts line ~423: change the toContain to 'reply gate could not read the transcript'.
2. Run: npx vitest run tests/reply-gate.test.ts tests/standing.test.ts tests/forced-handoff.test.ts tests/hook.test.ts; npm run typecheck.
3. CHANGELOG.md 0.5.26 entry, README step 6 and hooks/README line (fail closed, host fs read, 30 min active, standing gate). Not written.
4. Live behaviour unverified: whether `$.fs.read` of ~/.claude/projects/... works in the plugin host (path outside the tree); if it is refused the gate now holds the full 10 min instead of clearing at once.
5. node_modules was missing in the worktree (the shared link was dangling); I ran `npm ci` in the worktree (gitignored).
