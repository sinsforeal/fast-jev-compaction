# Jev 0.5.5 order marker notebook, 2026-10-14

Model Sonnet 5.5. Branch hybrid/order-marker-20261014 from 67f6823 (0.5.4). Started 20:32.

## Findings

- Stop plan did not trigger. Order path and clear path are both in `handoffStep` (hooks/handoff.ts); `config.handoffDir` there is already the captured root from `createHandoffRoots` (fast-jev.ts:696), and `onIdChanged` seeds the new id. So the marker needs no new wiring in fast-jev.ts.
- `$.fs` has read, write, list, exists, stat, ancestors. No rename, no delete (types/claude-code.d.ts:2608). Atomic write and removal therefore go through `$.process.run(argv)` (d.ts:2759): `cmd /c move /Y` and `cmd /c del /F /Q` on win32, `mv -f` and `rm -f` elsewhere. Temp file is `order.json.tmp`, written with `$.fs.write`.
- Fallback when the process call fails: marker written in place; removal rewrites it as `{"order":"none","ts":...}` and logs that. Readers must treat `order: none` as no order. A leftover `order.json.tmp` is possible only on that fallback path.
- `claude plugin validate` rejects `$.process` read as a value (`!!host.process`, `host.process?.run`). Only plain `host.process.run(...)` passes. So `HandoffHost.process` is a required field and a missing process surfaces as a caught TypeError.
- The validator now lists `$.process.run` in the calls of fast-jev.ts. The plugin newly depends on that host surface; if a policy refuses `process.run`, the fallback path applies.
- Marker `limit`: handoffAt for soon, handoffForceAt for now. `attempt`: SOON orders counted in new state field `soonOrders`; NOW uses `forcedOrders` (1 on first, 2.. on repeats).
- Log lines: the order line now reads `...; marker <path> (order soon|now); expecting <latest>`. `expecting` stays last because the 0.5.4 test regex `/expecting (\S+)/` reads the path. Repeats log `handoff order marker rewritten: <path> (now, attempt n, tokens/limit)`.

## Removal sites (hooks/handoff.ts)

- after the clear, in the detached work, before the resume submit: old id and new id folders (clearOrderMarker x2).
- gave up after forced repeats.
- clear not listed by the host (clearBlocked).
- third failed clear.

Not covered: a session that stops being hybrid while an order is out (handoffStep is not called then, so nothing removes it). A session that dies mid-order leaves its marker; folders are per id, so a stale one never touches a new id.

## Tried / failed

- First vitest run: no node_modules in the worktree, `npm ci` fixed it.
- First typecheck: `process` unknown in tsconfig.hooks (no node types). Used a `globalThis` cast for the platform check.
- First validate: failed on `!!host.process`, then on `host.process?.run`. Fixed as above.
- The bare_cd_gate hook blocks `cd` into tmp/; used `(cd ... && ...)` subshells.

## Stage

Code, tests (7 new in hybrid.test.ts, 152 total pass), typecheck clean, validate:plugin passed (the hook let it run), version 0.5.5 in four files, CHANGELOG, hooks/README.md. docs/HANDOFF_SKILL.md does not exist in this repo (it lives in each tree), not touched.

Left for Ryan: install 0.5.5, live check that `cmd /c move` and `cmd /c del` work through `$.process.run` on this PC (tests use a fake process over a file map), and the trees' Stop hooks reading order.json.
