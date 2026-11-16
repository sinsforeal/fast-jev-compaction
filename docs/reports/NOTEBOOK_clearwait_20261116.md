# Notebook: clear waits for a 10 min visible reply (tk-soox25), 2026-11-16

Stage 16:42: DONE for the branch. Code, tests, version 0.5.25, CHANGELOG, README. Install and session restarts are meta's. Delete this notebook when merged.

## Found
- 16:30 The clear is sent in `hooks/handoff.ts` `handoffStep`, in the detached work after `pause()`. Order: session id check, `checkAny`, `final` re-check, `host.command.run clear`.
- 16:32 Transcript jsonl marks the turn kind on the user record: human origin = his; channel peer, task-notification, plugin = not his; isMeta with no origin = companion. Interrupt: no origin, `[Request interrupted by user]`.
- 16:33 No feed or pick-assist record exists in any transcript on disk. That rule is copied from `standing.ts isUserPrompt`, not seen live.
- 16:34 A turn ends with a `system` `turn_duration` record.
- 16:38 The host `$.fs.read` is text only and rejects over 4 MiB, so it cannot read the tail of a 24 MB transcript. Hooks import no node modules. `process.getBuiltinModule('node:fs')` works under node 24 (tested here); not provable inside the plugin host from this worktree.
- 16:39 Real transcript 939421fb (2.8 MB): node read 12 ms, PowerShell helper 487 ms, 75 records both, identical view. 25.6 MB transcript 90371d2e: node 108 ms, PS 635 ms, 52 records both. The PS helper works first time (regexes, `$nl`, exit 0).

## Built
- `hooks/reply-gate.ts`: slimLine, parseTail, classifyUser, analyzeTail, gateWait, `readTailNode` (plain node:fs read of the last 24 MB), `hostNodeFs()`, `readTail` (node first, then hidden PowerShell helper on Windows, tail+grep elsewhere).
- `hooks/handoff.ts`: `holdForReply`, stale-file refresh, defer when a turn runs; 0.5.25 adds one `WARNING handoff: reply gate could not read the transcript` line per session (`gateReadWarned`), plain line after.
- `hooks/fast-jev.ts`: `replyVisibleMinMs` option, `replyGate` wired.
- Version 0.5.25 in plugin.json, marketplace.json, package.json, HOOK_ID, README 273/316, hooks/README 180, tests/forced-handoff.test.ts 438. `replyVisibleMinMs` in plugin.json userConfig, README option rows, README flow step 6, hooks/README, CHANGELOG.
- `tests/reply-gate.test.ts` 21 tests; `tests/hook.test.ts` defaults line gets `replyVisibleMinMs: 600000`.

## Tried / failed
- 16:40 First full vitest run: tests/hook.test.ts failed on the config defaults (new key). Fixed in the test.
- Not run: the plugin inside the real host (no install here), so `getBuiltinModule` in the host and the real `clock.sleep` in a live session are unproven.

## Left
- tools/jev_install.py (must show `problems: []`), then restart every live session. Check the first held clear in `~/.claude/fast-jev-compaction.log` for `clear held` / `clear goes` lines.
