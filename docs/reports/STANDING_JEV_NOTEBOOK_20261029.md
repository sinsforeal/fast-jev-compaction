READY: see git log head on feat/standing-jev (0.5.19, tsc clean, 144 tests pass in the 6 touched files)

# Standing Jev notebook, 10-29

Model: Sonnet 5.5.

## Done
- hooks/standing.ts (new): options parse, User-quiet, validate/clean, fork prompt, standingStep, standingClear, resume context.
- hooks/idle-warm.ts: Gap.standing/needMs/st, WarmState.standing, fireStanding, warmIdle(arm).
- hooks/handoff.ts: exports clearAvailable, waitForNewId, handoffBlocking.
- hooks/fast-jev.ts: window.json `standing` parse + log, arm built in armIdleWarm, prompt.submit notes the User and attaches STANDING RESUME.
- tests/standing.test.ts: 22 tests. Versions to 0.5.19, CHANGELOG.

## Gotchas
- node_modules was missing in the worktree; `npm ci` run in it (gitignored).
- package-lock.json was already at 0.5.17; left.
- Standing tree below minTokens: no ping at all (decision, matches "nothing").
- After a write the same fire goes on to clear; a ping is also sent when the clear is blocked (the fork already warmed it, small waste).

## Open
- hooks/README.md line 180 still says 0.5.18 in the receipt example.
- Build B's SessionStart/UserPromptSubmit hook would double the STANDING RESUME line; plugin carries it already.
- Live check owed: feed channel origin on prompt.submit (kind channel + server name, or unclassified + wrapper text).
