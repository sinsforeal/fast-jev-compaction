# JEV root drift notebook, 2026-10-22

Model: Sonnet 5.5. Branch fix/handoff-root-drift-20261022, cut from origin/main 719d6e4 (0.5.14).

## Findings
- `createHandoffRoots` in `hooks/fast-jev.ts` kept the raw cwd of the first event per id in an in-memory Map. A cwd of `...\var\handoffs` became the root and `var/handoffs` was joined onto it.
- `seed()` at a clear changed id only set the new id's root if it had none, so a drifted first event of the new id won.
- The roots Map is in memory only (nothing persisted), so "stored" bad roots live in the running hook; healing on read covers them.
- Windows mixed separators: `resolveAgainstCwd` joins with `\` and keeps the `/` of `var/handoffs`; `sessionFile` then uses `/`. Kept as is, tests expect `F:\REPS2\Mechanism_Analyst\var/handoffs/<sid>/latest.md`.

## Done
- `normalizeRoot`, `treeOfHandoffDir`, `findTreeRoot` in `hooks/handoff.ts`.
- Roots: normalise on capture and on every read, probe for the tree root, seed always overrides, `rootOf`, `useProbe`.
- `handoffStep`: `checkAny` falls back to `<treeRoot>/var/handoffs/<sid>/latest.md` when missing or older than the order; tree comes from the dir itself or `ctx.treeRoot`.
- Version 0.5.15 in package.json, package-lock.json, both plugin manifests, HOOK_ID, READMEs, forced-handoff test strings. CHANGELOG entry.
- `tests/root-drift.test.ts` (18 tests).

## Tried / failed
- Version bump first broke 4 tests in forced-handoff.test.ts that hardcode the HOOK_ID; fixed by bumping the strings.

## Stage
READY once the full suite is green and pushed. Not merged, tagged or installed.
