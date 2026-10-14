# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
tool calls, results and recognized message text are scored in bounded requests;
stale items are dropped or abridged, retained blocks stay verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library retains the projected history while removing stale
tool evidence and recognized injected blocks. Old long assistant replies can be
abridged to their opening and closing. Untagged user text and fenced examples stay
verbatim. Mid-turn instructions and rendered queued deliveries are pinned verbatim,
including after resume and in child loops. Depth is measured; reduction gates the cut.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   with at most four requests in flight and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed except for short supporting-evidence markers. The library returns
   untouched messages as the same objects and drops a call together with its result.
8. Recognized injected text and long replies are scored too, using bounded previews
   in the state. Pinned text is kept. Blocks whose evidence vanishes during state
   fitting are kept unscored. Recognition is structural: an unfenced user message
   imitating harness tags can match; set `injectedMinChars: 0` to disable it.
9. The Claude hook rebuilds all retained rows without opaque handles and groups
   consecutive assistant rows together. This removes stale IDs/parents, hidden
   thinking and media. A non-text placeholder records an otherwise empty result.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `injectedMinChars` | `1000` | Recognized injected blocks at least this long are scored; 0 disables it |
| `replyMinChars` | `2000` | Old assistant replies can be abridged; 0 disables it |
| `maxPostCompactTokens` | `0` | Hook only: warn above estimated visible size; never triggers summary; 0 disables warning |
| `logDecisions` | `false` | Hook only: opt-in kept/dropped probabilities and text decisions |

### 0.5.0 plugin options (read in `register`, from `pluginConfigs`)

| Option | Default | Description |
| --- | --- | --- |
| `compactAtTokens` | `160000` | turn.complete requests a prune when `context.tokens` >= this. When it is above 0 it replaces `compactAtPercent`; set `0` to use the percent trigger (also used when the token count is unreadable) |
| `compactAtPercent` | `60` | legacy trigger, percent of the model window; ignored while `compactAtTokens` > 0 |
| `targetVisibleTokens` | `64000` | real post-cut target: after the first Jev pass the plugin raises `keepThreshold` over the cached probabilities (steps of 0.05, then once past 1; no new Jev request) until `estimateSessionTokens` is at or under it. If the floor (pins, user prompts, short replies) is still above it, `replyMinChars` and `injectedMinChars` are halved once (floors 1100 / 200; newly eligible blocks are abridged or removed unscored) and the sweep repeats. The log line reports achieved size, threshold, floor stage. 0 disables |
| `maxPostCompactTokens` | `0` | legacy: only a warning above this estimate. Independent of the target |
| `handoffAt` | `250000` | visible size at which HANDOFF SOON is ordered, again per 50000 tokens of growth |
| `handoffForceAt` | `300000` | visible size at which HANDOFF NOW is ordered (raised to `handoffAt` if lower) |
| `handoffDir` | unset | absolute path; the session's files live in `<handoffDir>/<sessionId>/` (`latest.md`, `resumed.json`, `prune_skipped.json`); `<handoffDir>/current_session.json` follows the id. Unset = the handoff machine is off |
| `handoffSkillPath` | `docs/HANDOFF_SKILL.md` | path cited in the orders; relative paths resolve against the session cwd |

The plugin never requests the built-in summary. A reduction-ratio miss returns `{ skip }`, leaves the context as it is and writes `prune_skipped.json`; `compactTranscript` stays the offline recovery on transport failure. Every log line starts with `[first 8 chars of the session id]`.

Handoff flow (needs `DISABLE_AUTO_COMPACT=1` on the launcher; harness side):
1. After each main-loop turn, visible = post-cut estimate if a prune ran, else `context.tokens`.
2. At `handoffAt` the plugin submits HANDOFF SOON (once per 50000 more tokens); at `handoffForceAt` HANDOFF NOW.
3. The model writes `<handoffDir>/<sessionId>/latest.md`, header naming the session id, last line `COMPLETE`.
4. On a later turn the plugin accepts it only if it is newer than the order, names this session and ends in COMPLETE.
5. It writes `resumed.json` { by, file, mtime (ms), at }, then runs `/clear` (after checking `$.command.list()` has it).
6. It reads `$.session.id()` again; if changed it copies latest.md and resumed.json to the new id's folder; either way it writes `current_session.json`.
7. It submits HANDOFF RESUME naming latest.md and the skill's Resume section.
8. Not complete after NOW: the order repeats once per turn, 3 repeats at most, then "handoff not written" is logged and pruning goes on. Never a clear without a complete file.

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Visible post-cut tokens are estimated, excluding system instructions, tool schemas
  and hidden blocks. The outcome is a prepared replacement; the next request's
  measured prompt size is the acceptance check.
- Generated declarations are from 2.1.274; the supplemental delivery/API observers
  was verified on Claude Code 2.1.299. Older hosts may reject it during scanning;
  retain the 0.3.0 cache for rollback. Organization-managed installations can skip
  user-installed compaction hooks under managed policy.
- `targetVisibleTokens` counts the visible messages only, so the real context
  after a prune is the target plus the system and tool prefix.
- Handleless cuts discard unprojected assistant thinking and opaque media. Text
  blocks stay; dropped block kinds are logged. The API view is a bounded tail:
  it supplements the projection rather than
  replacing older history, and cannot prove unseen content outside that tail.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
feeds `session.compact` transcripts through `src/` and preserves observer-confirmed
instructions. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference and the verified 2.1.299 observer contract.

### Fidelity rules

Jev handles the first cut after startup or `--resume`, mid-turn submissions,
hidden rendered deliveries and subagent compactions. Accepted prompt text and
context, and queued attachments rendered as text, stay verbatim and unscored at
their observed chronological positions. Deliveries arriving during scoring are
inserted before returning the replacement. Rows get fresh host IDs and parents.
One separate provenance row records fingerprints and occurrence numbers of pinned
rows, so reload/resume preserves their pin status without changing instruction
text or writing a shared store. It is replaced, rather than multiplied, per cut.
`maxPostCompactTokens` (default 0) only warns. `minReductionRatio` (default 0.25)
is the skip gate: actual replacement characters, including pin
provenance, must meet that reduction or the cut is skipped. Equal-to-threshold cuts are retained.

Repeated prompts map by occurrence within observable anchors, then transcript
order when anchors are absent. API order conflicts retain the projected order
and recover only text spans not already represented. Every choice is logged.
Observer content gaps keep whatever text the transcript exposes and log the gap.

Request failures after retry, missing keys, invalid engine results and local
preparation failures use deterministic transcript recovery: preserve all text,
calls, pinned/recent results, and truncate eligible older results using the
existing head/evidence-note policy. Recovery is explicitly unscored. It passes
through the same reduction gate; a missed ratio skips the cut (`{ skip }`), writes
`<handoffDir>/<sessionId>/prune_skipped.json` and never requests the built-in
summary. `targetVisibleTokens` counts the visible messages only, so the real
context after a prune is the target plus the system and tool prefix.

A host without `session.compact` has no supported replacement installation API.
The usage hook logs that incompatibility and requests no built-in summary.
Such a host needs a compatible runtime before it can apply Jev replacements.

Every skip and recovery toasts its reason. With `logDecisions: true`,
the decision log also includes cumulative session-local skip counts by reason,
alongside kept/dropped probabilities. Error bodies and credentials are omitted.
Recovery reasons and chronology decisions also go to
`~/.claude/fast-jev-compaction.log`. Disk/UI failures never change a cut.
Speculative `precompute` remains vetoed.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add 'sinsforeal/fast-jev-compaction#hybrid/handoff-20261014'
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` and the
plugin's own token trigger go through Jev: the toast reads
`[sid] kept N/M messages, no summary (…; replacement prepared …)`
when the hook returns a replacement, or `[sid] skipped (…)` when Jev does not meet
the configured reduction ratio. The built-in summary is never requested. Run with
`DISABLE_AUTO_COMPACT=1` so the harness's own compaction stays out of the loop.

The branch-qualified source above selects the 0.5.0 candidate
(`hybrid/handoff-20261014`) without promoting the fork's default branch. Ryan v2
owns installation under queue hybrid-handoff-study-20261014. For an existing
declared source, preserve unrelated fields and set its GitHub `repo` to
`sinsforeal/fast-jev-compaction` and `ref` to `hybrid/handoff-20261014` before the
add/update commands. Confirm both marketplace and cached plugin manifests say
0.5.0 before reloading.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. Tests discover only
`tests/**/*.test.ts`, excluding baseline worktrees under `tmp/`. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
