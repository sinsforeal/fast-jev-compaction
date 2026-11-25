# Jev 0.5.33 notebook, 2026-11-24 (order delivery)

Stage: built, gated, pushed on fix/deliver-order-20261124. Merge, install and jev_load_probe are the orchestrator's; not run.

- 19:48 start. Read handoff.ts submit path (queueOrder, old line 438 DROPPED), console-clear.ts, standing.ts, CHANGELOG 0.5.20 to 0.5.32.
- Host events: grep of types/claude-code.d.ts found no "session can take input" event, a plugin's submit just "runs once the session is idle". So no retry route; console then peer.
- Peer sender: `send.py --whoami --from-name fast-jev-compaction` from here prints `session: process chain, claude pid ...` and tree meta. Inside the plugin host the helper runs under the target session's claude process, so the same logic would name the target as sender and send.py refuses self messages. So the helper calls `send.send(tree, text, from_tree=peerlib.SYSTEM_TREE, from_name='fast-jev-compaction', act=True)` (machine sender, act starts a stopped tree). Deviation from the brief's command line, on purpose.
- Tree from cwd: `peerlib.tree_of_cwd`. Real run: `tree_of_cwd('F:/automated_trading_V2')` printed `trading`, this worktree printed `meta`, `sender_identity(heartbeat, fast-jev-compaction)` printed `('heartbeat', 'fast-jev-compaction')`.
- Two call sites queue orders: turn end and `ratioMiss` (the first forced NOW). The second had no consoleClear wiring at all. First test run failed 5 cases with `console route: not wired; peer route: not wired` in the DROPPED line: ratioMiss ctx lacked consoleType, peerSend, treeRoot. Added.
- Double delivery: the prompt.submit hook carries `pendingOrders` text as context on the next prompt unless seen in the snapshot (not the event itself). A typed or peer-delivered order would have been carried a second time. Fixed: shared `deliveredOrders` map (replaces `carriedOrders`), and `event.text.includes(pending)` counts as seen.
- Console helper: long line typed with Enter in the same burst may read as a paste. Added FJ_SPLIT: text first, Enter 400 ms later (only for lines over 24 chars; /clear env unchanged). A first version always set FJ_SPLIT and broke console-clear.test.ts line 124 (env toEqual); made it conditional.
- Real run of the helper compile: the PS1 cut from console-clear.ts, run with mode `noop`: `{"pid":0,"error":"AttachConsole(0) failed, code 1341"}`, so Add-Type compiled and it reached the attach. No console typed into.
- Not run live: the full peer send (it would wake a real session), typed split Enter on a real console, `python` on the plugin host's PATH.
- Gate: see the final report.
