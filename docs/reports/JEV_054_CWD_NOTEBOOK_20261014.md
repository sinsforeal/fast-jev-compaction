# Jev 0.5.4 cwd notebook, 2026-10-14

Model: Sonnet 5.5. Worktree tmp/wt_jev_cwd, branch fix/handoff-cwd-20261014 from eb814e9 (0.5.3).

## Findings

- Cause: `resolvedCwd($)` called `$.session.cwd()` on every turn; that follows the Bash tool cwd. After `cd var/handoffs` the dir became `<root>/var/handoffs/var/handoffs`.
- Fix (hooks/fast-jev.ts): `createHandoffRoots()` returns one helper `resolve($, sid, path)`. First call for a sid with a readable cwd stores it in a Map; later calls join against the stored root. A differing later cwd logs one line per sid (Set `warned`). Unreadable cwd is not cached (retry next event).
- The map lives in `register()` (closure), not module scope, so tests with the same sid in separate harnesses do not leak.
- Used by: `writeSkipMarker` (prune_skipped.json), the turn.complete handoff step (handoffDir and handoffSkillPath, which also feeds current_session.json, latest.md, resumed.json via handoff.ts), and a capture call at the top of the `session.compact` handler so a compact can be the first event.
- handoff.ts unchanged. `resolveAgainstCwd` still the one join.
- Known gap: after the plugin's own `/clear` the new id captures the cwd at ITS first event. If the Bash cwd was drifted at clear time and survives the clear, the new id would capture the drifted cwd. The brief asked for per-id re-capture, so left as is. A cheap hardening would be to seed a new id from the previous id's root; not done.

## The 208357 vs 133725 question (plain explanation, not a bug fixed)

- Log, session 6bb960fe: 23:29:47 floor ~123177 (estimator, visible messages after the cut), prune applied, engine measured 87224. 23:29:48 order NOW "at ~123177".
- 23:32:56 floor ~133725 (same estimator), but `reduction 11% below 25% minimum`, so the prune was skipped, context left as is. In turn.complete (fast-jev.ts, the `outcome.skip === undefined` branch) `visible` is replaced by the post-cut estimate only when the prune was applied. On a skip `visible` stays `context.tokens`, the engine's real count (system and tool prefix and the uncut transcript): 208357. The repeated order (handoff.ts nowOrder) prints that value.
- So two different quantities: order text 208357 = real context.tokens on a skipped prune; log floor 133725 = estimator of a discarded cut; 123177 = estimator of an applied cut (engine said 87224 for it). Not caused by the drifted path (estimates do not read files). Real growth too: 123177 -> 133725 floor over three minutes.
- Left unfixed: the number in the order text mixes estimator and engine counts between turns, and `visible >= handoffForceAt` compares the same mixed value. Changing it is a design decision (which count the thresholds mean), not a plain bug.

## Tried / failed

- `claude plugin validate` was blocked by the agent_boundary hook (no launching claude from an agent). Not run. package.json script is `validate:plugin`.
- Wanted to prove the new tests fail on the old code via `git stash`; hook forbids stash. Skipped. The tests assert the single-root paths, which the old per-turn resolution cannot produce when cwd changes.
- `npm ci` was needed in the worktree (no node_modules).

## Stage

Code and tests committed and pushed. Version bump, CHANGELOG, README committed after. Install of 0.5.4 and live check are the orchestrator's.
