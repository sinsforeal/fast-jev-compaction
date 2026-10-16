# Jev tree warm notebook 2026-10-16

Build 0.5.12 on feat/tree-warm-20261016 (from v0.5.11, 4060e25).

## Findings

- idle-warm read `state.minutes`, `state.max`, `state.enabled` from the options at register time. prompt.submit and turn.complete were gated on `enabled`.
- windowFor/effectiveWindow (fast-jev.ts) already had the mtime cache and warn-once path. Reused it.

## Done

- idle-warm.ts: no global enabled; Gap carries minutes/max set at each warmIdle; minutes 0 cancels the timer.
- fast-jev.ts: window.json parse accepts idleWarmMinutes/idleWarmMax; negative or non-number rejects the whole file. A warm-only file is valid. EffectiveWindow got idleWarmMinutes, idleWarmMax, warmFromFile. New top-level armIdleWarm($,...) used by turn.complete and the dropped-submit path.
- Choice: idleWarmMax 0 in the file = option value (matches the option's own rule). Negative rejects.
- Log line names the warm only when the file has a warm key.
- Version bumped to 0.5.12. README, CHANGELOG, tests/tree-warm.test.ts.

## Tried / failed

- First bash call used a bare cd into tmp/; the gate refused it. Used a subshell after.

## Stage

Built, suite green (see report). Not installed, not tagged.
