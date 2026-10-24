# Jev clear retry notebook, 2026-10-23

Model: Sonnet 5.5. Branch jev_clear_retry from 39bb451 (0.5.15). Stage: built, tested, committed, pushed. Not tagged, installed or merged.

## Findings
- Diagnosis in Meta docs/reports/JEV_CLEAR_20261023.md. Defect: handoffStep step 1 gated on clearFailures < 3; at 3 the marker was deleted and nothing retried.
- Origin kinds for prompt.submit (types/claude-code.d.ts PromptOrigin): composer (typed), bridge (phone/web), sdk, task-notification, scheduled-trigger, peer, peer-send-message, projects-relay, plugin, unclassified. So a person prompt is composer or bridge. The host does give the info; the reset was built.

## Built
- hooks/handoff.ts: CLEAR_RETRY_COOLDOWN_MS, lastClearFailAt, cooldown reopen before step 1 (counter back to 0, new burst of 3), error text in the log line, marker kept at the cap, exported resetClearFailures.
- hooks/fast-jev.ts: prompt.submit handler calls resetClearFailures on composer/bridge origin.
- tests/forced-handoff.test.ts: harness advance(); old bounded-limit test now expects the marker to survive; new tests for error text, cooldown retry then clear, person reset vs peer prompt.
- Version 0.5.16 in plugin.json, marketplace.json, package.json, package-lock.json, README.md, hooks/README.md, HOOK_ID, test receipt string, CHANGELOG.md (same file set as the 0.5.15 bump).

## Tried / failed
- Nothing failed. No pre-existing failing tests. npm ci was needed first (no node_modules in the worktree).
- Deviation from the sketch: after the cooldown the counter goes to 0 (full burst), not MAX-1.

## Tests
- forced-handoff 42 pass, root-drift 18, color-carry 18, tsc -p tsconfig.hooks.json clean. handoff-window.test.ts not run separately (window sizing, unrelated).
