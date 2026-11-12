# Jev disk log lost-line race, notebook 11-12

Issue tk-8tqpub. Branch fix/log-append from main 35ce92a. Version 0.5.24.

## Findings

- `appendLog` (fast-jev.ts) and `warmLog` (idle-warm.ts) both did read whole log, write prior + line. Same defect in both.
- Host `$.fs` (types/claude-code.d.ts ~2608): read, write, list, exists, stat, ancestors. No append, no delete, no exclusive create. write replaces. So a lock file is not possible: nothing atomic to build it on. `$.process.run` exists in the host but a process per log line is heavy and a window risk; not used.
- `$.clock.sleep` is faked in the test harness as a pause that only `flush()` resolves, so it cannot be the wait inside appendLog. `setTimeout` is not in the hooks tsconfig types (types: []). Took the engine global via `globalThis.setTimeout`, no wait if absent.
- `$` cannot outlive its handler, so no deferred background verify. The check runs inside the awaited call.

## Built

- hooks/disk-log.ts: `appendDiskLine(fs, path, entry)`. Write, settle 25 ms, read back, retry if our line is missing. Max 4 writes, no new try past 900 ms. Read-back throw stops. Trim inside the write. `setLogSettleMs` is a test seam.
- Both callers pass closures over `$.fs.exists/read/write` (a bare `$.fs` pass is avoided, per the 0.4.x loader notes).
- tests/setup.ts + vitest.config.ts setupFiles: settle 0 for the suite.
- Version 0.5.24 in package.json, both .claude-plugin manifests, README.md, hooks/README.md, HOOK_ID, the receipt test. package-lock.json untouched (last bump did not touch it).

## Tried and failed

- First cut had the 25 ms wait always on. 13 existing forced-handoff tests failed: they drive detached clear flows with `flush()` (setImmediate) and the wait made the log writes late. Fixed with the seam and setup file.
- My give-up test asserted the disk held the receipt. It did not: the stubbed read hides our lines, so a later line (window.json warn) replaces them. Asserts the `[floor-se] ` tag instead.

## Checks

- Mutation: MAX_TRIES = 1 makes the two-host test fail (1 receipt instead of 2). Restored to 4.
- `npx vitest run` whole suite: 23 files, 396 passed. `npm run typecheck` clean.
- Not run: any real two-process test. The race is simulated on a shared fake disk only.

## Left open

- Pre-existing: if the log exists but the first read throws, prior is '' and the write replaces the whole log. Not changed (brief: write as today).
- Install and restarts are the meta orchestrator's.

## Stage

Committed and pushed on fix/log-append. Not merged, not installed.
