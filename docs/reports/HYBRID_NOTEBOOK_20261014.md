# Hybrid 0.5.0 notebook 2026-10-14 (Sonnet, wt_hybrid, started 18:20)

Stage at 18:27: code and tests done and green (133 passed); docs partly done. Hit the 50-call checkpoint, so this is the stop point.

## Done
- src/compact.ts: replan(), fitTarget(), thresholdLadder() (cached probabilities, no Jev request).
- hooks/handoff.ts (new): state machine, checkLatest, followSessionId, order texts.
- hooks/fast-jev.ts: options (resolveHookConfig), tag() log prefix, skip + prune_skipped.json (writeSkipMarker), no next() in session.compact, turn.complete trigger by tokens, hysteresis (notBefore, +32000), handoff step, detached submit/clear.
- tests/hybrid.test.ts (11), three old tests changed to the skip behaviour, hook.test defaults.
- README: options table, no-summary statement, handoff flow.

## Findings
- d.ts: $.command.run (2484-2504) "rejects an unknown name, and inside a hook the turn is waiting on"; does not name clear. $.prompt.submit (2390-2402) "runs when idle". Neither says whether turn.complete is a hook the turn waits on, so both calls are detached (void, after a 250 ms $.clock.sleep) and clear is gated on $.command.list() containing "clear". Live check owed.
- d.ts does not say whether clear keeps the session id (id() 2293: "the transcript file's name"); handled both ways (current_session.json).
- Ids of unscored text blocks shift when replyMinChars changes, so cached answers are keyed by index:start:end:kind.
- Defaults per coordinator: compactAtTokens 160000 (Ryan 18:39: reads plus rewrites per turn balance 85k to 120k above the 94k post-cut; 128000 would prune every ten turns), targetVisibleTokens 64000, option names handoffAt / handoffForceAt.

## Tried / failed
- A bash sed on hooks/handoff.ts was blocked by the agent_boundary hook (relative path); used Edit with absolute paths.

## Stage at 18:30 (second agent, hit the 45-call checkpoint)
Done: coordinator fix, no optional-chained $ noun left in hooks/ (fast-jev.ts tag/writeSkipMarker/cwd, handoff.ts pause() and plain `$.command.list()` in try; LogHost/SkipHost types now non-optional, a missing noun throws inside the existing try). Versions 0.5.0 in package.json, package-lock.json (lines 3, 9), plugin.json, marketplace.json:13. Six new userConfig entries in plugin.json. Test added in tests/hybrid.test.ts (session.compact with targetVisibleTokens 6000: no next(), estimate <= target, one Jev request). tsc x2 clean, suite 134 passed.
Still owed (pick up here): CHANGELOG 0.5.0 entry; README cleanup (Fidelity rules para "a missed ratio can still request core" ~line 203, install line 229/241-246 "0.4.4 candidate", toast line 238 "fallback to built-in summary", config table in hooks/README.md lines 53-66 + fallback text lines 72-88, targetVisibleTokens counts visible messages only); live checks: $.command.run clear, $.prompt.submit detached, session id at a clear; orchestrator runs `claude plugin validate`.

## Remaining, in order (older list; items 2 partly done above)
1. CHANGELOG.md 0.5.0 entry (not read yet).
2. .claude-plugin/plugin.json userConfig: add compactAtTokens, targetVisibleTokens, handoffAt, handoffForceAt, handoffDir, handoffSkillPath; bump version in plugin.json, marketplace.json (line 13), package.json (and package-lock.json) to 0.5.0; remove "branch-qualified 0.4.4" wording in README install section; update README "Fidelity rules" paragraph that still says a missed ratio can request core, and the "fallback to built-in summary" toast sentence.
3. hooks/README.md options mention.
4. `claude plugin validate .` on the worktree.
5. Optional tests: logDecisions skip counts; session.compact with targetVisibleTokens end to end (only fitTarget is unit tested).

## Stage at 18:45 (third agent, docs)
Docs done. Found on arrival: CHANGELOG 0.5.0 entry, README options/handoff/install/fidelity text and hooks/README config table and trigger text were already rewritten for 0.5.0. Fixed what was left: CHANGELOG said compactAtTokens default 128000 (now 160000); README "sole built-in-summary gate" for minReductionRatio reworded to a skip gate; the targetVisibleTokens "visible messages only" sentence added to README Limitations. Noted: README handoffAt/handoffForceAt rows say "visible size" while the order texts say "unprunable context"; same number (post-cut estimate or context.tokens), left as is. Live checks still owed: $.command.run clear, $.prompt.submit detached, session id at a clear.

Gotchas: node_modules installed with npm ci in the worktree (gitignored). The turn.complete handler needs $.session.id; hosts without it get no prefix and no handoff step.

## Stage at 19:22 (0.5.3, per-tree handoffDir)

- The User's rule, one writer per store: `handoffDir` relative resolves against `$.session.cwd()`; absolute stays. Default `var/handoffs` (HOOK_DEFAULTS, plugin.json), so the machine's dir is always set now (it still runs only in a hybrid session).
- Helper `resolveAgainstCwd(cwd, path)` in hooks/handoff.ts (the old `resolveSkillPath` body, now also used for the skill path). fast-jev.ts: `resolvedHandoffDir`/`resolvedCwd` for the skip marker; the handoff step gets the resolved dir. handoff.ts itself builds paths only from the config it is given (already resolved), so current_session.json, latest.md and resumed.json follow.
- Tests: three cases in tests/hybrid.test.ts (relative, default, absolute); tests/hook.test.ts defaults fixture gained handoffDir. The harness `session.cwd` throws when no cwd is given, which covers the no-cwd fallback (path stays relative).
- `claude plugin validate` skipped: the agent_boundary hook blocks it from an agent.
- First attempt at the version bump used sed on relative paths and was blocked by agent_boundary (cwd not the worktree); redone with Edit on absolute paths.

## Stage at 19:03 (0.5.2, Ryan v2)

- The User 18:59: with Jev unavailable a hybrid session never cuts blind; `session.compact` skips with `prune_skipped.json` (reason `Jev unavailable (...)`) and counts `jev_unavailable`; the handoff takes over at handoffAt/handoffForceAt. Non-hybrid sessions keep the 0.4.4 transcript recovery cut.
- Six 044 recovery tests ran under a shim that hardcodes `DISABLE_AUTO_COMPACT=1`; they now override the env to non-hybrid. New hybrid test covers both branches.
- Model slug: the fork sends `jev-latest` (no `model` pin in the user options); the response and log carry no version, so which Jev build the alias resolves to is not observable from here.
