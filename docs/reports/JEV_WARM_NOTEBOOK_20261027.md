# Jev warm timer reset, notebook 10-27

Stage: WIP commit at call limit (13:00). hooks/idle-warm.ts DONE (noteActivity, warmTouch, warmEpoch, warmSubmit, warmIdle(epoch), fireWarm(state): sid drop, live-id check, real-idle check with remainder re-arm).

NOT done, in order:
1. hooks/fast-jev.ts wiring: import warmTouch, warmEpoch. In the session.append handler (~line 769) add `if (sid && event.agentId === undefined) warmTouch(idleWarm, sid)`. In turn.complete (~1017) and the dropped-submit path (~817) read `const epoch = warmEpoch(idleWarm, sid)` before armIdleWarm and pass it as a new last param through to warmIdle.
2. tests/idle-warm.test.ts and tests/tree-warm.test.ts: fire() must move Date now (vi.useFakeTimers({ toFake: ['Date'] }) in beforeEach, harness records Date.now() inside clock.after, fire() does vi.setSystemTime(armedAt + ms)), because a ping needs a full interval of real idle; tests that fire at once would otherwise re-arm instead of fork. New tests: turn resets the timer (complete, +30 min, submit+complete: first timer cancelled, new live), clear resets (sid change drops old timer; an old timer fired after the id change does not fork), no ping before idleWarmMinutes of real idle (append at +40 min, fire at +50 re-arms ~10 min, no fork), ping after (advance, fork called), epoch race (submit between turn.complete and its arm).
3. `npx tsc --noEmit`, `npm run typecheck:hooks`, vitest on idle-warm, tree-warm, host-loader-contract, then the full suite once.
4. CHANGELOG 0.5.18 entry + README "Idle cache warm" paragraph. Do not bump the tag, land or install.

Gotchas: npm ci already run in the worktree. Heredocs are refused, use Edit/Write. Use (cd W && cmd), not a bare cd. Windows python needs F:/ paths, not /f/. Baseline before changes: idle-warm 13 + tree-warm 9 pass.

## Findings

- idle-warm.ts keeps one Gap per sid in `state.gaps`. warmSubmit/warmIdle only touch the Gap of the sid they are called with. Nothing ever drops or checks a Gap whose sid has gone away.
- ~/.claude/fast-jev-compaction.log (kept from 10-24 21:09, older lines trimmed): per tag there are two interleaved chains. Example edefadf6: n=4 21:19, n=5 22:09, n=1 22:18, n=6 22:59, n=7 23:49, n=1 00:35, n=8 00:39, n=9 01:29. The n=1 chains die at the next turn (normal). The n=4..9 chain never resets across hours of turns, and its cache_read grows with the live context (196751 -> 221662), so it forks the live conversation. Same cache_read/cache_write pair on the n=5 ping (22:09) and the n=1 ping (22:18): 221662/382, one conversation, two timers.
- That is a Gap keyed by a sid that no longer receives events (pre-clear or pre-handoff id), whose timer survives and pings the current conversation until it hits idleWarmMax. Matches the study's "timer from the pre-clear session firing into the new one" and its 77% wasted pings. The [sid] log tag is the live id at fire time, not the id the Gap was armed under, hence "unreliable".
- Second gap: no activity signal besides prompt.submit and turn.complete. A turn started by a delivery (channel message, task notification) with no prompt.submit never cancels the timer; a turn longer than the interval gets pinged mid-turn.
- Third gap (small): turn.complete awaits cwd/window lookups (armIdleWarm) before warmIdle runs. A queued prompt submitted right after turn.complete runs warmSubmit first, then warmIdle sets running=false and arms a timer for a turn that is already running.

## 10-20 07:05 (study: meta 370 min, trading 361 min, 7-10 pings logged)

- The log no longer has 10-20 (trimmed). Used F:/temp/window_defense/warm_matched.json (370 matched pings) and gaps.json.
- Trading bb9488de: matched pings in the gap are two chains of n=1..4 (01:00, 01:50, 02:40, 03:30 and 01:56, 02:46, 03:36, 04:26). Trading idleWarmMax is 4 (max n ever seen on trading in the set is 4). Last ping 04:26, cache dead 05:26, next turn 07:06:41. Cause: idleWarmMax 4 x 50 min = 200 min covers less than the 361 min gap. By design, not a bug. The doubled chain is the zombie above, it did not extend coverage.
- The two events within a minute of each other are one cause chain: the User's "Why is nothing moving" at 07:05 to meta (HISTORY 10-20 00:45-07:08), meta relayed to trading 57 s later (user_wake True on meta, False on trading). Not a shared outside event. No account swap in var/limits/events.jsonl that night (only memory swap grants), no effort/model change at that hour (var/effort_arm_log.jsonl).
- Meta 21687c6d: 10 pings tag-matched in the gap, ping cost 0.084 USD total = reads of ~39k each, so they did read the prefix. Last ping time is not recoverable (matched set only holds the 01:33 n=1 ping, the rest fell outside warm_match.py's 400-entry candidate window). With a 50 min chain the last ping is within 50 min of 07:05, inside the 1 h TTL, yet the turn wrote 40139 tokens. Meta's cap was 12 (n=12 appears in the set), 12 x 50 does not run out inside 370 min. Unable to determine for meta: TTL and cap do not explain it, a prefix change between the last ping and the turn (system/tools/CLAUDE.md block) would, but I have no record of one.

## Plan

- idle-warm.ts: WarmState gets `sid` and `lastActive`; every Gap knows its sid and an epoch. `warmTouch` on activity; a new sid drops every other Gap (clear resets). Fire checks: Gap still the live sid (state and `$.session.id()`), real idle >= interval since lastActive (else re-arm for the remainder).
- fast-jev.ts: session.append (main thread) touches; turn.complete and dropped submit pass the epoch so a prompt that came during the arm wins.
- Tests in tests/idle-warm.test.ts; harness gets a faked Date and a settable sid.

## Tried / failed

(nothing yet)
