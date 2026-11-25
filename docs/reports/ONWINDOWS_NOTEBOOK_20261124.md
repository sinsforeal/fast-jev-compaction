# onWindows notebook, 2026-11-24 (tk-2a7dt9, Jev 0.5.31)

Worktree tmp/wt_jevwin, branch fix/onwindows-20261124, from origin main 14eb6a5 (0.5.30).

## Findings

- `onWindows()` existed 4 times, each `globalThis.process?.platform === 'win32'`: handoff.ts:157, color-carry.ts:29, console-clear.ts:23 (exported, used by fast-jev.ts:1124 and standing.ts:381). In the host `globalThis.process` is not usable (0.5.26 changelog), so all four were false.
- readTail is gone: reply-gate.ts was removed in 0.5.30. Nothing to fix there; noted in the changelog.
- Host surface (types/claude-code.d.ts): `$.fs` has read, write, list, exists, stat, ancestors. No rename, no delete (so the "use fs.rm" idea is not possible; cmd move/del stays). `$.fs.read` rejects over 4 MiB. `$.env.get(name)` takes a string literal. `$.process.run(argv)` has no shell.
- Loader rules that shaped the code: no `host.fs.x` read as a value (0.5.28) so stat is called inside try; `$` only goes to top-level functions or imports (host-loader-contract test passes).
- Real transcripts on this PC run 3 MB to 33 MB; most are over 4 MiB late in a session, so the JS read only covers small ones and findstr stays for the rest. No transcript here holds an `agent-color` record (grep over ~/.claude/projects found none), so the live color read has no real record to find on this PC.

## Design

- hooks/platform.ts `detectWindows(host, hints)`: process.platform win32, drive/UNC path hint, env OS=Windows_NT, env SystemRoot drive path. Only positives count: a host `process` shim saying linux is not trusted over a `F:/` path.
- `platformSource.processPlatform` is a mutable hook so tests run both branches on one machine.

## Tried and failed

- First test run after the code change: 5 failures in tests/color-carry.test.ts (`expected 1 to be 10`, `expected [ Array(2) ] to include 'run:color red'`). Cause: the fake `fs.stat` returned size 0 for missing files and a small size for the empty fixture transcripts, so the new JS route found no record before the process route ran. Fix in the fake only: stat rejects for a missing file (like the host) and reports a size over the read limit for a transcript unless `readable`.
- First attempt at a node_modules junction pointed at wt_standing_jev, which no longer exists. Re-pointed at wt_jevresult/node_modules (git ignores it). safe_delete refuses a junction, `cmd /c rmdir` removed it.

## Checks

- `tsc --noEmit` and the hooks tsconfig: clean.
- `vitest run` whole suite: 24 files, 429 tests passed before the forced-handoff addition; tests/forced-handoff.test.ts 51 after.

## Stage

Committed and pushed on the branch; merge and `tools/jev_install.py` (must show "problems": []) are the lead's. Not loaded in any session until a restart onto 0.5.31.
