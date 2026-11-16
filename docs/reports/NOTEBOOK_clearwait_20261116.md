# Notebook: clear waits for a 10 min visible reply (tk-soox25), 2026-11-16

Stage: WIP. Code written and type-checked, NOT tested, NOT run on the real transcript. Stopped at the 60 call cap.

## Found
- 16:30 The clear is sent in `hooks/handoff.ts` `handoffStep`, in the detached work after `pause()`. Order: session id check, `checkAny` (file newer than order, header names sid, last line COMPLETE), `final` re-check, `host.command.run clear` (console fallback on the stopped refusal). Today nothing compares the file with the transcript.
- 16:32 Transcript jsonl marks the turn kind on the user record. His message: `origin {"kind":"human"}`, `promptSource` typed or queued, `turnOrigin human`. Peer: `isMeta true`, `origin {"kind":"channel","server":"peer"}`, `turnOrigin peer`. Task notification: `origin.kind task-notification`. Plugin prompt (HANDOFF NOW / RESUME, the /clear caveat): `origin.kind plugin`. Stop-hook feedback, system-reminder companion, image note: `isMeta true`, no origin key. Interrupt: no origin, text `[Request interrupted by user]`.
- 16:33 No feed or pick-assist record exists in any recent transcript on disk (150 newest files searched, only the MCP instruction text mentions them). So the feed/pick-assist rule is copied from `standing.ts isUserPrompt` (origin channel + server feed|pick-assist, or the `<channel source="feed"` wrapper). Not seen live.
- 16:34 Turn shape: in two real meta transcripts every non-companion user record is followed by exactly one `system` `turn_duration` record before the next user record (u/e alternate, 0 uu, 0 ee); an interrupt record closes a turn without one. So "a turn is running" = last of (user prompt, turn_duration, interrupt) is a user prompt.
- 16:35 `$.clock.after` (idle-warm) and `host.clock.sleep` (handoff.ts, used up to 30 s today) are the timer seams. I used `host.clock.sleep` in 30 s slices inside the detached clear work. The turn hook returns at once, so the session is free.

## Built (not tested)
- `hooks/reply-gate.ts` (new): `slimLine` (regex on raw jsonl lines, never JSON.parse of a big line), `parseTail`, `classifyUser`, `analyzeTail` (last reply to him, busy flag, newest prompt time), `gateWait`, `clockText`, `readTail` (PowerShell helper `reply-tail.ps1` written next to the handoff files on Windows, `tail|grep` elsewhere), `TAIL_HELPER_PS1`.
- `hooks/handoff.ts`: `replyGate` in `StepContext`; `holdForReply` (reads tail, logs `handoff: clear held N s: last reply to the user at HH:MM:SS`, sleeps, re-reads so a new reply restarts the clock, logs `handoff: clear goes, ...`); unreadable transcript -> log and clear goes (never blocks); after a hold a running turn defers the clear to the next turn end; after a hold, a prompt newer than the file mtime -> new NOW order (max 2, `refreshes` in state), the turn end after the fresh file clears.
- `hooks/fast-jev.ts`: `replyVisibleMinMs` (default 600000, 0 = off) in `HOOK_DEFAULTS`, `HookConfig`, `resolveHookConfig`; `replyGate` wired into the turn.complete `handoffStep` call.
- `tsc --noEmit -p tsconfig.hooks.json` and `tsc --noEmit`: no output (clean) after the `HOOK_DEFAULTS.handoffDir` fix.
- `node_modules` in this worktree is a symlink to `tmp/wt_standing_jev/node_modules` (it did not exist). One `npx tsc` call before the link fetched a junk `tsc@2.0.4` into the npm cache; it ran nothing.

## Not done (next agent)
1. `.claude-plugin/plugin.json` userConfig entry `replyVisibleMinMs` (number, default 600000, "0 = off") and version 0.5.25 in plugin.json, marketplace.json, package.json, `HOOK_ID` in fast-jev.ts, README.md lines 273/316, hooks/README.md line 180, tests/forced-handoff.test.ts line 438 (module-loaded string).
2. CHANGELOG 0.5.25 entry at the top; README + hooks/README lines for the clear timing and the option row.
3. `tests/reply-gate.test.ts`: slimLine on real-shaped lines; classifyUser (human, feed, pick-assist, peer, task-notification, plugin, stop-hook feedback, interrupt, no-origin legacy); 2 min old reply holds to 10 min; 11 min clears at once; last turn peer clears at once; new reply during wait restarts the clock; setting 0 off; unreadable transcript clears; busy after hold defers; stale file after hold re-orders (and clears on the next turn end). Harness: fake clock whose `sleep` advances `now`; copy `setup()` from tests/console-clear.test.ts. Existing handoff tests are unaffected by default: their `process.run` returns exitCode 1 for the tail helper, so the gate reads as unreadable and the clear goes.
4. Run on the real thing: build with `F:/temp/cw/build.cjs` (not written, Write was blocked), run `readTail` through the real PowerShell helper over `C:/Users/zenzen/.claude/projects/F--REPS2-Meta-Orchestrator/939421fb-0e85-4e71-800a-cf350d786cac.jsonl`, paste the last five turns. The PowerShell helper has never been executed: check the 24 MB read, the regexes, `$nl`, exit code.
5. `npx vitest run` on touched tests, `npx tsc` again, `python tools/red_list.py mine --since 637e795`.

## Known risks
- The PS helper is unrun. If it fails, `readTail` returns not ok and the clear goes (old behaviour), so the failure is silent except for a log line `reply gate could not read the transcript`.
- Standing clear (standing.ts) is not gated: it needs the User quiet 60 min already.
- Transcript timestamps and `host.clock.now()` must be the same machine clock; they are on the PC.
