# Notebook: remove the 10 minute reply hold (2026-11-24)

Order: the User 11-24 14:59, "Remove the 10 minute hand over limit." Branch fix/drop-reply-visible-20261124, version 0.5.30.

- Removed: the option in plugin.json, README (row and flow step 6 text), hooks/README (row and paragraph); HookConfig field, default and parse in fast-jev.ts; the gate builder in fast-jev.ts; the hold function, slice sleep, constants and the stale-file refresh in handoff.ts; the standing clear's gate and arm field in standing.ts; hooks/reply-gate.ts.
- Tests removed: tests/reply-gate.test.ts, the hold case in forced-handoff.test.ts and standing.test.ts, the reply-gate case in host-loader-contract.test.ts; harness and hook.test.ts defaults lose the option.
- Old notebooks of the feature removed (NOTEBOOK_clearwait_20261116, NOTEBOOK_replyhold_20261118, commitmsg_replyhold_wip).
- Check: npm run typecheck clean; npx vitest run 23 files, 400 tests passed; git grep of the option and function names hits only CHANGELOG.md.
- Setup note: the clone's node_modules is a dangling link, so npm ci was run in this worktree (node_modules is ignored). A bgjob npm ci (1124-150237-7cf3) was filed first and sat held in the limits queue (#17 of 18); it is harmless, the foreground npm ci finished in 2 s.
- Stage: done, pending the merge and `tools/jev_install.py`; not installed, not loaded.
