# Notebook: warm ping under the standing minimum, 0.5.23, 2026-11-05

Issue tk-dv2un. Branch fix/warm-under-standing-min-20261105 from 47b20ea (0.5.22).

## Found
- `hooks/standing.ts` `standingStep`: under minTokens (or tokens unreadable) logged the skip line and returned `{kind:'stop'}`. No ping, no timer.
- `hooks/idle-warm.ts` `fireStanding` already pings on a `ping` step: counts `gap.count`, logs `idle warm n after m min`, re-arms while `n < gap.max`. So the fix is one new input to `standingStep`.
- Values are not hard-coded. `gap.minutes` and `gap.max` come from `armIdleWarm` in fast-jev.ts via `windowFor`: window.json `idleWarmMinutes`/`idleWarmMax` over the options. Code defaults: `HOOK_DEFAULTS.idleWarmMinutes` 0 (off), `idleWarmMax` 6. The 50 min / 12 / trading 4 are deployed settings, not code defaults.

## Built
- `standingStep(..., underMinPingMs = 0)`: if under min and `underMinPingMs > 0`, return `{kind:'ping', delayMs: min(coldBoundaryMs, underMinPingMs)}`, no skip line. 0 keeps the old skip line and stop.
- `fireStanding` passes `gap.minutes * 60000` (0 when the warm is off for the tree).
- Version 0.5.22 to 0.5.23 in plugin.json, marketplace.json, package.json, README.md (2), hooks/README.md, hooks/fast-jev.ts HOOK_ID, tests/forced-handoff.test.ts. package-lock.json says 0.5.17, the last commits did not touch it, left.
- CHANGELOG.md entry.

## Decisions
- First check stays at 60 - coldMargin (55 min). The old plain schedule pinged first at 50. Context is only known after an await at fire time, so the timer cannot be armed per size without changing the standing path. 55 is still inside the 60 min TTL. Later pings are spaced `idleWarmMinutes` (50) from the previous ping.
- Unreadable context also pings (the old plain warm pinged regardless).
- idleWarmMinutes 0 = off for the tree: no ping, old skip line. Matches pre-standing (off) and the existing rule that 0 is off.

## Tests
- No node_modules in the worktree; `npm ci` in the worktree (gitignored).
- One existing test asserted the old behaviour (under min: no ping): rewritten for idleWarmMinutes 0, new ping test added. "no pings after a clear" asserted the new small session is not pinged: that is the exact hole, changed to expect one ping.
- Added: spacing and no skip line, cap then stop and reset by a new turn, window.json spacing/cap, growth past min goes to standing path, exactly 150000 unchanged, non-standing under 150k unchanged.

## Stage
Tests run, committed and pushed (see report for SHA). Not installed, not merged.
