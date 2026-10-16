# Jev idle warm notebook, 2026-10-16

Branch feat/idle-warm-20261016 from v0.5.10 (83bb866). Model: Sonnet 5.5.

## Findings (step 1)

1. fork shares the main cache. types/claude-code.d.ts:2171-2186: "Runs one tool-less completion over the session's OWN transcript, sharing the main thread's prompt cache ... the model and system prompt are the session's, read from its last turn's cache-safe snapshot, and tools are denied. Null on a cold snapshot or an API error." Confidence: confirmed that this is the stated intent; inferred that the bytes match (tools "denied" may mean the tool list is sent and calls refused, or dropped; if dropped the prefix would miss). Unknown until the live run.
2. Docs back it for the Agent-tool fork. code.claude.com/docs/en/prompt-caching, "Subagents and the cache": "A fork ... inherits the parent's system prompt, tools, and conversation history exactly, so its first request reads the parent's cache." Compaction "uses the same prefix-sharing approach"; prompt suggestions "reuse the conversation's prompt cache" (docs/en/costs). Confidence: confirmed for the Agent fork, inferred that $.model.fork is the same machinery.
3. TTL bucket. Same page, "Which TTL each request gets": forks are in "Everything else" (5 min default on a subscription), not "Main conversation" (1 h). Confidence: confirmed by doc. Consequence: the fork's own NEW tail (our one user message plus the reply) is written at 5 m. Small. The prefix read hits the existing 1 h entry, and "Each request that hits the cache resets the timer" (same page, Cache lifetime). API behavior: a hit refreshes the TTL of the entry it hit, so the 1 h entry should stay 1 h. Confidence: inferred (API semantics, not stated for forks). Setting CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h would make the tail 1 h too; not needed.
4. Main transcript. d.ts:4411-4418 ModelForkRequest.prompt: "The one user message, appended to the session's own transcript." Ambiguous: could mean appended to the request copy, or written to the transcript file. Confidence: unknown. Live check: session jsonl line count before and after a warm. Compaction and prompt suggestions do the same trick without adding turns, so the request copy reading is likely.
5. Cost knobs. ModelForkRequest has only `prompt`; no maxTokens, no model (d.ts:4411-4420). ModelCompleteRequest has maxTokens (default 256) but complete has no history. So output cap is only controlled by the prompt text ("Reply with the single word ok"). Thinking models (Opus 5.5 cannot disable thinking, docs/costs) may emit thinking tokens that count as output. Confidence: confirmed (types), thinking cost unknown.
6. Usage exposed. ModelForkResult = { text, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } } (d.ts:4424-4446). So the log line can carry real numbers. Confirmed.
7. Timers. d.ts:2718-2731: `$.clock.after(ms, fn)` returns a Timer (d.ts:8210) with cancel(). "A timer's callback is the plugin's own function ... a hot reload of the plugin cancels its pending waits". Each timer is one host dispatch that hooks can refuse. Confirmed.
8. Idle detection. No idle event found. turn.complete (d.ts:3374) "follows the last" request; prompt.submit (d.ts:3156). Running state: track ourselves: set `running` on prompt.submit, clear on turn.complete (main thread only, agentId undefined). A timer firing while running is skipped and not re-armed (turn.complete re-arms).

Verdict: fork can plausibly read and refresh the main prefix. Not provably. Build behind default-off option; live measurement decides.

## Tried

- First cut had a closure factory (createIdleWarm) with methods. Native loader rule (tests/host-loader-contract.test.ts) allows `$` only into top-level functions. Rewrote as module-level functions + a state object (hooks/idle-warm.ts).
- Timer callback closes over the `$` of the hook call that armed it. Docs say the callback is "the plugin's own function, kept in its environment"; whether a stale `$` stays usable is unknown until the live run.

## Failed

- Contract test caught the closure factory (3 violations). Fixed.
- hook.test.ts pinned the exact config shape; added the two new keys.

- `claude plugin validate` (npm run validate:plugin) rejected `warmHost = $` ("$ itself is assigned"). `$` cannot be stored, so idle-warm.ts has its own warmLog($, text) and the timer's `$` writes the line. Validate now passes.

## Stage

Committed and pushed on feat/idle-warm-20261016 (head SHA in the report). Done: everything in the brief except the live measurement. Remaining: live run by the parent (install, set idleWarmMinutes, read the log line). Gotcha: `$` must never be stored or assigned in hooks/*.ts.

Code, tests, README, CHANGELOG, version bump done. Full suite 19 files / 275 tests pass, typecheck clean. Live measurement not run (needs install; not allowed here).
