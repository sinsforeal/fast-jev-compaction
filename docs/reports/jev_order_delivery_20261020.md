# Jev order delivery, notebook 2026-10-20

Branch fix/order-delivery-20261020 off origin/main 2e2a97b. Model: Sonnet.

## Findings

- The order is not a Claude Code settings hook. Jev is a module plugin. The NOW/SOON order goes out as `$.prompt.submit({ text })` from `queueOrder` in `hooks/handoff.ts`, detached (`void work().catch`), after a 250 ms sleep, with a session id check that returns silently on mismatch. It appears in the transcript as a user message "The fast-jev-compaction plugin sent a message:" and a `queue-operation enqueue` row right after the Jev log line (see 4997bac3: log 12:19:41.526, enqueue 12:19:41.853, user 12:19:41.881).
- 21687c6d: four orders logged (12:06:59, 12:09:30, 12:10:03, 12:16:01Z). After none of them is there an enqueue row or a plugin message. The next user records are peer messages and task notifications. "HANDOFF NOW" is absent from the transcript after 04:43 (resume order). So the submit never reached the engine. No "submit failed" log either, so it did not reject. It either hung, returned `{ drop }` (result was never read), or hit the silent session id mismatch return.
- Scan of all 188 logged orders against all transcripts (F:\temp\ordscan.py): every other order was delivered, some late (5 s to 1088 s: queued behind peer messages and user prompts, normal). Only the 4 orders of 21687c6d never arrived. Pending background agents are not the cause (delivered with 1 to 9 pending).
- Settings hooks ruled out: ran clock_context, queue_watch, efficiency_flags with a plugin-style UserPromptSubmit payload: exit 0, no block. user_asks_capture and claude_md_reload not run (they write state), but their sources have no block path. No UserPromptSubmit attachment appears in 21687c6d between 12:06:59 and 12:08:41, so no hook ran for the order at all.
- Meta settings.local.json has no Jev entry and needs none (module plugin, enabled in ~/.claude/settings.json).
- Proven: submit produced nothing visible, and Jev did not look at the result. Not proven: whether it hung, dropped, or mismatched ids (no log of it exists). The 0.5.14 logs will say next time.

## Fix (0.5.14)

- `pendingOrders` map (handoff.ts) set in `queueOrder`, deleted in `clearOrderMarker`.
- `prompt.submit` hook (fast-jev.ts) attaches the pending text as `context` to the next non-plugin prompt (peer, user, notification), once per text, unless a user message in the session already holds the text.
- Own submit now logs returned/DROPPED(reason)/not submitted(id mismatch).
- Tests in tests/forced-handoff.test.ts, 296 green.

## Residual

- A session that gets no prompt at all (pure tool loop, no peers, no notifications) still gets no order until its next prompt. Autonomous loops should not occur for orchestrators.
- If the engine later delivers the queued own submit after a carry, the model sees the order twice. Harmless: same instruction.

## Advisor window

- Advisor session 7e3df1b6-95d8-4c1b-82e0-4c4107495468 (transcripts in C:\Users\zenzen\.claude\projects\F--REPS2-Strategy-Advisor). Log: 12:08:52Z and 14:42:30Z "[7e3df1b6] handoff window 500000/500000, idle warm 50 min x12 from window.json (arm single order at 500k, no SOON; ...)". It reads F:\REPS2\Strategy_Advisor\var\handoffs\window.json (500000). Same code path as the others, no difference in delivery.
- Trading and Pick log 250000/250000 from their window.json. Meta read 500000 from its own window.json 11:54Z to 12:06Z (arm text said required reading, ~180k) and went back to 250000 at 12:06:59Z, the same turn end the NOW order fired at 280k. The 500k Meta window was a leftover; reverted by Meta itself.

## Live tree settings

None needed.

## Stage

Done. Not tagged, merged or installed.
