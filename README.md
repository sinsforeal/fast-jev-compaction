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
verbatim. Accepted instructions and rendered queued deliveries are pinned,
including after resume and in child loops. Only an exact generated background-event
preamble may be shortened; instructions and event payloads stay verbatim.
Depth is measured; reduction gates the cut.

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
   removed except for one history-level supporting-evidence warning. Old repeated
   generated warnings are consolidated, while quoted/fenced examples remain. The library returns
   untouched messages as the same objects and drops a call together with its result.
8. Recognized injected text and long replies are scored too, using bounded previews
   in the state. Pinned text is kept. Blocks whose evidence vanishes during state
   fitting are kept unscored. Recognition is structural: an unfenced user message
   imitating harness tags can match; set `injectedMinChars: 0` to disable it.
9. The Claude hook rebuilds all retained rows without opaque handles and groups
   consecutive assistant rows together. This removes stale IDs/parents, hidden
   thinking and media. A non-text placeholder records an otherwise empty result.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw in the library. The hook retains context in hybrid sessions and uses
unscored transcript recovery otherwise. A recovery cut still has to meet the
reduction floor. No hook path requests the built-in summary.

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
  // Keep the original transcript and request a written handoff instead.
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

### Plugin options (read in `register`, from `pluginConfigs`)

| Option | Default | Description |
| --- | --- | --- |
| `compactAtTokens` | `160000` | With `DISABLE_AUTO_COMPACT=1`, turn.complete requests a prune when readable `context.tokens` >= this. Above 0 it replaces `compactAtPercent`; `0`, missing/unreadable token counts, or a missing/unreadable launcher flag use the percent trigger |
| `compactAtPercent` | `60` | Percent-of-window trigger when the hybrid token trigger does not apply |
| `minReductionRatio` | `0.25` | Strictly below this actual character reduction, skip the cut and immediately force a written HANDOFF NOW, independent of launcher flag and token thresholds. Exactly equal passes. Never requests a built-in summary |
| `targetVisibleTokens` | `64000` | With `DISABLE_AUTO_COMPACT=1` only: after the first Jev pass, raise `keepThreshold` over cached probabilities (steps of 0.05, then once past 1; no new Jev request) until `estimateSessionTokens` is at or under the target. If pins, user prompts and short replies still exceed it, halve `replyMinChars` and `injectedMinChars` once (floors 1100 / 200), then repeat the sweep. Newly eligible blocks are abridged or removed unscored. Logs report achieved size, threshold and floor stage. 0 disables |
| `maxPostCompactTokens` | `0` | legacy: only a warning above this estimate. Independent of the target |
| `handoffAt` | `250000` | With `DISABLE_AUTO_COMPACT=1`: visible size at which HANDOFF SOON is ordered, again per 50000 tokens of growth |
| `handoffForceAt` | `300000` | With `DISABLE_AUTO_COMPACT=1`: visible size at which HANDOFF NOW is ordered (raised to `handoffAt` if lower). A ratio miss forces NOW regardless of this size |
| `handoffDir` | `var/handoffs` | Session files live in `<handoffDir>/<sessionId>/` (`latest.md`, `resumed.json`, `prune_skipped.json`, `order.json`); `<handoffDir>/current_session.json` follows the id. Relative paths use the cwd captured on the session's first compaction or turn-complete callback, cached per session id; later cwd changes do not move the files. Absolute paths share one root |
| `window.json` | none | Not an option: a per-tree override file, see "Per-tree handoff window" below |
| `handoffSkillPath` | `docs/HANDOFF_SKILL.md` | Path cited in the orders; relative paths use the same captured cwd as `handoffDir` |
| `idleWarmMinutes` | `0` | 0 = off. Otherwise warm the prompt cache this many minutes after each turn ends, see "Idle cache warm" below |
| `idleWarmMax` | `6` | Warms per idle gap before the session counts as abandoned |

The plugin never requests the built-in summary. A reduction-ratio miss returns `{ skip }`, retains history and pins, writes `prune_skipped.json` and requests HANDOFF NOW immediately. This applies when `DISABLE_AUTO_COMPACT` is `1`, missing, another value or unreadable, even below the token thresholds or without usage counts. The persisted force reason continues the cycle after callback reload or loss of the flag. Every log line starts with `[first 8 chars of the session id]`.

Handoff flow:
1. After a non-aborted main-loop turn, visible = post-cut estimate if a prune ran, else actual `context.tokens` when available. Token-threshold orders require `DISABLE_AUTO_COMPACT=1`; ratio-forced orders do not.
2. At `handoffAt` submit HANDOFF SOON (once per 50000 more tokens); at `handoffForceAt` submit HANDOFF NOW. A ratio miss queues NOW from the compaction callback without waiting for a threshold. That callback cannot clear or repeat an outstanding order.
3. Pending orders write `order.json` with `order`, `ts`, actual `tokens` (or `null`), configured `limit`, `attempt` and, for ratio-forced orders, `reason`. No token count is fabricated to cross the force threshold.
4. The model writes `<handoffDir>/<sessionId>/latest.md`. Its first 10 lines must name the exact session id, not a prefix or suffix match. Its last non-empty line must be `COMPLETE`.
5. On a later non-aborted main-loop completion, accept only a regular file newer than the latest order. Stat before and after reading; its mtime and size must stay unchanged. Check that `$.command.list()` lists `clear`, then queue the detached clear.
6. After the detached delay, check the session id and file again. Write `resumed.json` with `{ by, file, mtime, at }`, log the pending clear, then revalidate the file and session id immediately before `$.command.run({ command: "clear" })`. The file must still be valid and have the same mtime and size as the version recorded in `resumed.json`. Any invalid/replaced file or changed session retains context. The marker is written before these final checks, so its presence alone does not prove a clear.
7. Read `$.session.id()` after clear. If changed, copy latest.md and resumed.json into the new id's folder. Write `current_session.json`, remove pending-order markers and submit HANDOFF RESUME naming latest.md and the skill's Resume section.
8. Missing or invalid files cause at most 3 later NOW repeats, one per completion, after the initial order. The completion that first forced NOW does not duplicate it. Aborted turns neither repeat nor clear. After the repeat budget, log "handoff not written" and retain context. A missing/unreadable clear capability blocks clear; a failing clear gets at most 3 attempts. Neither path requests a summary or submits RESUME without a successful clear.

#### Per-tree handoff window

`pluginConfigs` is user-level, so `handoffAt` and `handoffForceAt` are one value for every tree. For a
different window per tree, put `window.json` in the resolved `handoffDir` (default: `<session cwd>/var/handoffs/window.json`):

```json
{"handoffAt": 200000, "handoffForceAt": 250000, "arm": "B", "until": "2026-10-17T01:00"}
```

- Read at each turn completion and ratio miss, cached by mtime (unchanged file = one stat, no parse). Edit it live, no restart.
- `handoffAt` must be a number of at least 50000. `handoffForceAt` is raised to `handoffAt` if lower. Either key may be left out; the option value fills in.
- Missing file: the options win, nothing is logged. Malformed JSON, a non-number, or `handoffAt` under 50000: the file is ignored, the options stay, one warning per mtime in `~/.claude/fast-jev-compaction.log`.
- `arm` and `until` are labels only. A change (file appears, changes, disappears) logs one line, e.g. `handoff window 200000/250000 from window.json (arm B)` or `handoff window back to options 250000/300000`.
- 0.5.12: the file may also carry `idleWarmMinutes` and `idleWarmMax` (numbers), which override the two options of the same name for this tree only, see "Idle cache warm". A missing key falls back to the option. `idleWarmMinutes: 0` switches the warm off for the tree even if the option is on; a tree with the option off and `idleWarmMinutes: 50` in its file warms. `idleWarmMax: 0` means the option value (as for the option). A non-number or negative warm value rejects the whole file, same as a bad `handoffAt`: one warning per mtime, the options stay in force. A file with only warm keys is valid.
- The warm reads the per-tree value at each arm (every main `turn.complete`, and a dropped submission), so editing the file takes effect at the next turn end. A gap already armed keeps the interval and cap it was armed with. When the file carries a warm key the change line names it: `handoff window 150000/200000, idle warm 50 min x2 from window.json (arm block1 W1 S1)` (`idle warm off` when minutes is 0).
- Each SOON/NOW log line carries `window <at>/<force> from <source>`, and `order.json` has a `window` field, so a trial readout shows which arm a handoff ran under.

#### Idle cache warm

Off by default. The main conversation's prompt cache lives one hour on a subscription; a longer gap makes the next turn rewrite the whole context at the write price. With `idleWarmMinutes` > 0 (pick under the lifetime, e.g. 50):

- After each main-thread `turn.complete` one `$.clock.after` timer is armed per session. A new `prompt.submit`, `turn.complete` or main-thread `session.append` (a delivery-started turn, a tool result) resets the idle clock; the first two cancel and re-arm the timer, an append makes an early timer re-arm for the remainder.
- A new session id (a clear or handoff) drops every timer of the old id, and a timer that fires under an id that is no longer the live one sends nothing. A ping goes out only after a full `idleWarmMinutes` with no activity; the warm's own pings do not count as activity.
- When it fires and no turn is running, one `$.model.fork({ prompt: "Reply with the single word ok." })` is sent. The fork runs over the session's own transcript and shares the main prefix (docs: "a fork ... inherits the parent's system prompt, tools, and conversation history exactly, so its first request reads the parent's cache"), and a cache hit resets the TTL. Then it re-arms, at most `idleWarmMax` times per gap.
- It never submits a prompt, never warms during a turn, and a failing or null fork is logged once and stops warming for that gap.
- Log line per warm in `~/.claude/fast-jev-compaction.log`: `[sid8] idle warm <n> after <m> min: cache_read <r>, cache_write <w>, out <o>`. A first warm with `cache_read` near the context size and a small `cache_write` is the proof that the main prefix was read.
- Limits: `$.model.fork` takes no max-token or model setting, so the output cap is the prompt. Forks sit in the "everything else" TTL bucket (5 minutes), so the fork's own few new tokens are written at 5 minutes; the read prefix keeps its one hour entry.

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Visible post-cut tokens are estimated, excluding system instructions, tool schemas
  and hidden blocks. The outcome is a prepared replacement; the next request's
  measured prompt size is the acceptance check.
- Generated declarations are from 2.1.274; the supplemental delivery/API observers
  are verified on Claude Code 2.1.300, including API `type: "text"` delivery blocks
  and legacy `kind: "text"` projections. Older hosts may reject it during scanning;
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
Claude Code 2.1.274 type reference and the verified 2.1.300 observer contract.

### Fidelity rules

Jev handles the first cut after startup or `--resume`, mid-turn submissions,
hidden rendered deliveries and subagent compactions. Accepted prompt text and
context, and queued attachments rendered as text, stay verbatim and unscored at
their observed chronological positions. Deliveries arriving during scoring are
inserted before returning the replacement. Rows get fresh host IDs and parents.
Pin fingerprints, occurrence numbers and notification-text policies live in the
host's persistent plugin store under a session-and-child-specific key. They are
not model-visible text. Legacy inline provenance is migrated at an accepted cut.
Writes are verified before returning the replacement; a failed write uses inline
provenance for that cut. A missing or unreadable record conservatively protects
user text. Prior fingerprints are retained so a rejected replacement cannot lose
the old history's pins. The host's 4 MiB store limit uses the same inline fallback.
The store contains fingerprints and policies, never prompt or event text.

Exact generated background-event warnings become a concise non-approval label.
Human submissions are protected verbatim, even when they paste that warning.
Legacy rows have no origin, so only warning-only fragments with recognized
prefixes are shortened; ambiguous prefixes and event payloads stay untouched.
Arrivals during final persistence/diagnostics are restored synchronously with
inline provenance, which the next accepted cut can migrate.
`maxPostCompactTokens` (default 0) only warns. `minReductionRatio` (default 0.25)
is the skip gate: actual replacement characters, including fallback inline pins,
are compared with the original incoming history plus net recovered text. Savings
from removed bookkeeping count. Equal-to-threshold cuts are retained.

Repeated prompts map by occurrence within observable anchors, then transcript
order when anchors are absent. API order conflicts retain the projected order
and recover only text spans not already represented. Every choice is logged.
Observer content gaps keep whatever text the transcript exposes and log the gap.

Request failures after retry, missing keys, invalid engine results and local
preparation failures retain context when `DISABLE_AUTO_COMPACT=1`. They write
`prune_skipped.json`; token-threshold handoff orders still apply. Other sessions
use deterministic transcript recovery: preserve text, calls and pinned/recent
results, then truncate eligible older results with the existing head/evidence-note
policy. Recovery is explicitly unscored and passes the same reduction gate.
A miss there also retains history and forces a written handoff immediately.
No failure path requests the built-in summary. `targetVisibleTokens` applies
only with the launcher flag and counts visible messages, not the system/tool prefix.

A host without `session.compact` has no supported replacement installation API.
The usage hook logs that incompatibility and requests no built-in summary.
Such a host needs a compatible runtime before it can apply Jev replacements.

Skips and recovery report their reasons; repeated ratio-force notices are deduplicated
per session per callback registration. With `logDecisions: true`, the decision log
also includes cumulative session-local skip counts by reason, alongside kept/dropped
probabilities. Error bodies and credentials are omitted. Recovery reasons and
chronology decisions also go to `~/.claude/fast-jev-compaction.log`.

The first callback for each session per registration writes a disk-only receipt:
`module-loaded hook=fast-jev-compaction@0.5.18/forced-handoff-floor; session=<full id>; DISABLE_AUTO_COMPACT=<classification>`.
The classification is `1`, `unset`, `other` or `unreadable`, never a raw environment
value or error body. A cache or manifest version alone is not a loaded receipt.
Callback re-registration can emit another receipt for the same session.
Routine opaque-block receipts also stay on disk; cut summaries, applied measurements,
errors and fidelity-gap warnings remain visible. UI log lines are transcript
diagnostics, not model context. Disk/UI failures never change a cut.
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
claude plugin marketplace add 'sinsforeal/fast-jev-compaction#main'
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
The flag opts into the token trigger, target fitting, skip-on-Jev-error policy and
token-threshold handoff orders. Missing or unreadable flags use the percent trigger
and unscored recovery on Jev errors. They never restore summary fallback: every
ratio miss still forces a written handoff. Keep the flag set to disable the harness's
own automatic compaction; the plugin cannot disable an independent harness path.

The branch-qualified source above selects the maintained `main` release.
For an existing declared source, preserve unrelated fields and set its GitHub
`repo` to `sinsforeal/fast-jev-compaction` and `ref` to `main` before updating.
Confirm both marketplace and cached plugin manifests say 0.5.18 before reloading,
then require a fresh callback `module-loaded` receipt for the intended full session id.
Native function-hook scanning and a live handoff remain separate install checks;
unit tests and a version string do not prove either.

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
