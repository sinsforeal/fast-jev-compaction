import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { applyDecisions, compact, decideCall, fitTarget, messageChars, reductionRatio, resolveOptions, type TargetFit } from '../src/compact.js';
import { handoffStep, resolveAgainstCwd, sessionFile, type HandoffHost } from './handoff.js';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import type { DeliveryOn } from './runtime-contract.js';
import { FidelityLedger } from './fidelity.js';
import { recoverApiHistory, type RuntimeMessages } from './api-history.js';
import { readPinProvenance, appendPinProvenance, pinProvenanceTexts, collectPins,
  pinStoreKey, readPinRecord, mergePins, type Pin } from './pin-provenance.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  isRetryableStatus,
  parseJevResponse,
  JevHttpError,
  JevResultError,
} from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  compactAtTokens: 160_000,
  targetVisibleTokens: 64_000,
  handoffAt: 250_000,
  handoffForceAt: 300_000,
  handoffSkillPath: 'docs/HANDOFF_SKILL.md',
  handoffDir: 'var/handoffs',
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  logDecisions: false,
  maxPostCompactTokens: 0,
};

/** After a prune or a skip, the next trigger needs this much growth past the post-cut (or skipped) size. */
const PRUNE_HYSTERESIS_TOKENS = 32_000;

// Keep the source identity in failure receipts: an old loaded module can outlive a cache update.
const HOOK_ID = 'fast-jev-compaction@0.5.8/forced-handoff-floor';
type EnvHost = { env: { get(name: string): Promise<string | undefined> } };
async function autoCompactFlag($: EnvHost): Promise<'1' | 'unset' | 'other' | 'unreadable'> {
  try {
    const value = await $.env.get('DISABLE_AUTO_COMPACT');
    return value === '1' ? '1' : value === undefined ? 'unset' : 'other';
  } catch { return 'unreadable'; }
}
/** ENV selects token triggers/target fitting only. It can never authorize a summary fallback. */
async function hybridSession($: EnvHost): Promise<boolean> {
  return await autoCompactFlag($) === '1';
}

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  /** 0 = off (percent trigger); otherwise turn.complete compares context.tokens against it. */
  compactAtTokens: number;
  /** 0 = no target; otherwise a prune is re-run with a rising keepThreshold until under it. */
  targetVisibleTokens: number;
  handoffAt: number;
  handoffForceAt: number;
  handoffDir?: string;
  handoffSkillPath: string;
  minReductionRatio: number;
  model: string;
  logDecisions: boolean;
  maxPostCompactTokens: number;
};

class JevRequestError extends Error {}

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positive(value: number, fallback: number): number {
  return value > 0 ? Math.floor(value) : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'injectedMinChars',
    'replyMinChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    compactAtTokens: Math.max(0, Math.floor(optionNumber(options, 'compactAtTokens', HOOK_DEFAULTS.compactAtTokens))),
    targetVisibleTokens: Math.max(0, Math.floor(optionNumber(options, 'targetVisibleTokens', HOOK_DEFAULTS.targetVisibleTokens))),
    handoffAt: positive(optionNumber(options, 'handoffAt', HOOK_DEFAULTS.handoffAt), HOOK_DEFAULTS.handoffAt),
    handoffForceAt: positive(optionNumber(options, 'handoffForceAt', HOOK_DEFAULTS.handoffForceAt), HOOK_DEFAULTS.handoffForceAt),
    handoffSkillPath: optionString(options, 'handoffSkillPath') ?? HOOK_DEFAULTS.handoffSkillPath,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    logDecisions: typeof options.logDecisions === 'boolean' ? options.logDecisions : HOOK_DEFAULTS.logDecisions,
    maxPostCompactTokens: Math.max(0, Math.floor(optionNumber(options, 'maxPostCompactTokens', HOOK_DEFAULTS.maxPostCompactTokens))),
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  config.handoffDir = optionString(options, 'handoffDir') ?? HOOK_DEFAULTS.handoffDir;
  // The forced limit can never sit under the write limit.
  if (config.handoffForceAt < config.handoffAt) config.handoffForceAt = config.handoffAt;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/**
 * A `JevAsker` over the engine's `$.http.fetch`; one jittered retry after a 403, 429 or 5xx.
 * The hook runtime has no `setTimeout`, so the wait is the engine's `$.clock.sleep`, passed
 * in; without one the retry is immediate.
 */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  sleep?: (ms: number) => Promise<void>,
  retries = 1,
  retryDelayMs = 1500,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      for (let attempt = 0; ; attempt++) {
        let response: HookFetchResponse;
        try {
          response = await fetchFn(request.url, {
            method: request.method, headers: request.headers, body: request.body,
          });
        } catch {
          if (attempt < retries) {
            if (sleep) await sleep(retryDelayMs * (attempt + 1));
            continue;
          }
          throw new JevRequestError('Jev transport failed after retry; details omitted');
        }
        if (!response.ok && attempt < retries && isRetryableStatus(response.status)) {
          if (sleep) await sleep(retryDelayMs * (attempt + 1) * (0.75 + Math.random() * 0.5));
          continue;
        }
        return parseJevResponse(response.status, response.ok, response.text);
      }
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * Every returned row is fresh and handleless. A reused handle retains the host's
 * message.id and stale parentUuid, multiplying text and bypassing the new compact
 * boundary on resume. Consecutive assistant rows are rebuilt together so a
 * parallel response cannot be split between old and new identities.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
  pinned?: Set<number>,
  policies?: Map<number, Message['notificationText']>,
): SessionMessage[] {
  const rebuiltMessages: SessionMessage[] = [];
  for (const message of output) {
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map(toolUseSummary),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => ({ ...toolResultSummary(result), text: result.text || NON_TEXT_NOTE }),
      );
    }
    if (!rebuilt.text && !rebuilt.toolUses.length && !rebuilt.toolResults?.length) {
      if (rebuilt.role === 'assistant') continue; // unprojected thinking-only row
      rebuilt.text = NON_TEXT_NOTE;
    }
    const last = rebuiltMessages[rebuiltMessages.length - 1];
    // Keep independent user prompts separate; combine only adjacent result rows.
    const merge = last?.role === rebuilt.role && (rebuilt.role === 'assistant' ||
      (!last.text && !rebuilt.text && !!last.toolResults?.length && !!rebuilt.toolResults?.length));
    if (merge && last) {
      last.text = [last.text, rebuilt.text].filter(Boolean).join('\n\n');
      last.toolUses.push(...rebuilt.toolUses);
      if (rebuilt.toolResults?.length) last.toolResults = [...(last.toolResults ?? []), ...rebuilt.toolResults];
    } else rebuiltMessages.push(rebuilt);
    if (message.pinned && message.role === 'user') {
      pinned?.add(rebuiltMessages.length - 1);
      if (message.notificationText) policies?.set(rebuiltMessages.length - 1, message.notificationText);
    }
  }
  return rebuiltMessages;
}

const NON_TEXT_NOTE = '[fast-jev-compaction: non-text content was present here; it was removed from the projected history]';

/** Visible conversation estimate; excludes system/tool-schema prefix and hidden blocks. */
export function estimateSessionTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify({
    role: message.role, text: message.text,
    toolUses: message.toolUses.map(tool => ({ id: tool.tool_use_id, name: tool.tool, input: tool.input })),
    toolResults: (message.toolResults ?? []).map(result => ({ id: result.tool_use_id, text: result.text })),
  })) + 4, 0);
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
  pins?: Pin[];
};

/** Offline recovery uses only the transcript: preserve every call and text,
 * truncate eligible old results using the existing evidence-marker policy.
 * No invented probabilities, network request or summary. */
function compactTranscript(messages: readonly Message[], config: HookConfig): CompactResult {
  const resolved = resolveOptions(config);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const decisions = calls.map(call => decideCall(call, { keepCall: 1, keepResult: 0 }, { keepThreshold: 0.5 }));
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return { messages: kept, decisions: [], textDecisions: [], stats: {
    messagesBefore: messages.length, messagesAfter: kept.length,
    charsBefore: messages.reduce((n, m) => n + messageChars(m), 0),
    charsAfter: kept.reduce((n, m) => n + messageChars(m), 0),
    calls: calls.length, kept: 0, resultsDropped: decisions.filter(d => d.action === 'drop_result').length,
    callsDropped: 0, pinned: calls.filter(c => c.pinned).length,
    texts: 0, textsRemoved: 0, duplicatesRemoved: 0, repliesAbridged: 0, textsUnrepresented: 0,
    stateTokens: 0, stateStage: 'transcript recovery (unscored)', requests: 0, ms: 0,
  } };
}

function recoveryReason(error: unknown): string {
  if (error instanceof JevHttpError) return `Jev HTTP ${error.status}; retry policy exhausted`;
  if (error instanceof JevRequestError) return error.message;
  if (error instanceof JevResultError) return 'invalid or out-of-range Jev engine result';
  // Arbitrary transport messages may contain secrets or output. Keep the error
  // class and a fixed diagnostic reason; never echo their bodies.
  return 'local transcript preparation or scoring failed';
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new JevRequestError('TYPESAFE_API_KEY is not configured');
  const asker = jevAsker(fetchFn, config.apiKey, config.model, sleep);
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult, visiblePost = estimateSessionTokens(result.messages)): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.textsRemoved > 0 ? `${stats.textsRemoved} text blocks removed` : '',
    stats.duplicatesRemoved > 0 ? `${stats.duplicatesRemoved} duplicates removed` : '',
    stats.repliesAbridged > 0 ? `${stats.repliesAbridged} replies abridged` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; estimated visible post-cut ~${visiblePost} tokens; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  const calls = result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    );
  const texts = (result.textDecisions ?? []).filter(d => d.reason !== 'pinned' && d.reason !== 'small')
    .map(d => `${d.id}:${d.kind}:${d.action}/${d.reason}/keep=${d.reason === 'unrepresented' ? 'unscored' : d.keep.toFixed(2)}`);
  return [...calls, ...texts].join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

type LogHost = {
  session: { id: () => Promise<string> };
  ui: { log: (text: string) => void; toast: (text: string, options?: { timeoutMs?: number }) => void };
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
};
const LOG_FILE = '.claude/fast-jev-compaction.log';
const LOG_KEEP_CHARS = 512_000;

/** 0.4.2: every toast and log line also lands on disk, under the user's home
 * (`~/.claude/fast-jev-compaction.log`), so a fallback reason or a kept cut can be
 * read back after the toast is gone. The host exposes `fs.write` only (no append):
 * read, trim to the newest half once over the cap, write. Never throws, never
 * changes a cut. */
async function appendLog($: LogHost, text: string): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
    if (!home) return;
    const path = `${home.replace(/[\\/]+$/, '')}/${LOG_FILE}`;
    let prior = '';
    try { if (await $.fs.exists(path)) prior = await $.fs.read(path); } catch { prior = ''; }
    if (prior.length > LOG_KEEP_CHARS) prior = prior.slice(prior.length - LOG_KEEP_CHARS / 2);
    await $.fs.write(path, `${prior}${new Date().toISOString()} ${text}\n`);
  } catch { /* a log that cannot be written never changes a cut */ }
}

/** 0.5.0: every log and notify line starts with the first 8 characters of the session id
 * (`[1ef048ab] ...`), so three sessions' lines in one disk log can be told apart.
 * No id (a host without `session.id`) leaves the line as it is. */
async function tag($: { session: { id: () => Promise<string> } }, text: string): Promise<string> {
  try {
    const id = await $.session.id();
    if (typeof id === 'string' && id.length > 0) return `[${id.slice(0, 8)}] ${text}`;
  } catch { /* an id that cannot be read never blocks a line */ }
  return text;
}

async function log($: LogHost, text: string): Promise<void> {
  const line = await tag($, text);
  await appendLog($, line);
  try { $.ui.log(line); } catch { /* UI failure cannot change compaction. */ }
}

// Routine opaque-block receipts belong on disk. ui.log is not model context,
// but still fills the visible transcript. Missing-content/chronology warnings
// remain visible because they describe a gap rather than an expected projection.
async function logFidelity($: LogHost, note: string): Promise<void> {
  if (!note.includes('not carried handleless')) return log($, `fidelity: ${note}`);
  await appendLog($, await tag($, `fidelity: ${note}`));
}

async function notify($: LogHost, text: string): Promise<void> {
  const line = await tag($, text);
  await appendLog($, line);
  try { $.ui.log(line); } catch { /* UI failure cannot change compaction. */ }
  try { $.ui.toast(line, { timeoutMs: 15_000 }); } catch { /* Disk receipt already written. */ }
}

async function countFallback(
  $: LogHost,
  counts: Map<string, number>, reason: string, enabled: boolean,
): Promise<void> {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  if (enabled) try { $.ui.log(await tag($, `skip counts: ${Array.from(counts, ([r, n]) => `${r}=${n}`).join(' ')}`)); } catch { /* diagnostic only */ }
}

type SkipHost = LogHost & {
  session: { id: () => Promise<string>; cwd: () => Promise<string>; usage: () => Promise<{ context: { tokens?: number } }> };
};

/** `<handoffDir>/<sessionId>/prune_skipped.json`: { at, reason, tokens, estimate }. Never throws. */
async function writeSkipMarker($: SkipHost, roots: HandoffRoots, config: HookConfig, reason: string, estimate: number, actualTokens?: number): Promise<void> {
  if (!config.handoffDir) return;
  try {
    const id = await $.session.id();
    if (!id) return;
    let tokens: number | undefined = actualTokens;
    if (tokens === undefined) try { tokens = (await $.session.usage()).context.tokens; } catch { tokens = undefined; }
    const dir = await roots.resolve(await resolvedCwd($), id, config.handoffDir, text => log($, text));
    await $.fs.write(sessionFile(dir, id, 'prune_skipped.json'),
      JSON.stringify({ at: new Date().toISOString(), reason, tokens: tokens ?? null, estimate }));
  } catch { /* a marker that cannot be written never changes a cut */ }
}

/**
 * The one place the handoffDir/handoffSkillPath options become paths: relative = per tree, absolute = shared.
 * 0.5.4: a relative path joins the cwd seen on the FIRST event of the session id (the launch cwd);
 * that root is cached per session id and a later `cd` by the model never moves it.
 */
type CwdHost = { session: { cwd: () => Promise<string> } };
type HandoffRoots = {
  /** `now` is the session cwd read by the caller this turn; `warn` logs the one drift line. */
  resolve: (now: string | undefined, sid: string, path: string, warn: (text: string) => Promise<void>) => Promise<string>;
  /** After a clear changed the id: the new id inherits the old id's root unless it already has one. */
  seed: (from: string, to: string) => void;
};
function createHandoffRoots(): HandoffRoots {
  const roots = new Map<string, string>();
  const warned = new Set<string>();
  return {
    seed(from, to) {
      const root = roots.get(from);
      if (root !== undefined && !roots.has(to)) roots.set(to, root);
    },
    async resolve(now, sid, path, warn) {
      const captured = roots.get(sid);
      if (captured === undefined) { if (now !== undefined) roots.set(sid, now); return resolveAgainstCwd(now, path); }
      if (now !== undefined && now !== captured && !warned.has(sid)) {
        warned.add(sid);
        await warn(`handoff root stays at the captured cwd ${captured} (session cwd is now ${now})`);
      }
      return resolveAgainstCwd(captured, path);
    },
  };
}

async function resolvedCwd($: CwdHost): Promise<string | undefined> {
  try { return await $.session.cwd(); } catch { return undefined; }
}

/** A callback receipt, not a manifest/cache assertion. Disk only, once per session. */
async function loadedReceipt($: LogHost, loadedSessions: Set<string>): Promise<void> {
  let sid: string;
  try { sid = await $.session.id(); } catch { return; }
  if (!sid || loadedSessions.has(sid)) return;
  loadedSessions.add(sid);
  const flag = await autoCompactFlag($);
  await appendLog($, `[${sid.slice(0, 8)}] module-loaded hook=${HOOK_ID}; session=${sid}; DISABLE_AUTO_COMPACT=${flag}`);
}

type RatioMissState = {
  fallbackCounts: Map<string, number>;
  handoffRoots: HandoffRoots;
  forcedThisTurn: Set<string>;
  notBefore: Map<string, number>;
  forceNotices: Set<string>;
};

// Host-taking helpers must stay module-local for the native hooks loader.
// The mutable state still belongs to each registration, never to this module.
async function ratioMiss(
  $: SkipHost & HandoffHost, configured: HookConfig, state: RatioMissState,
  sid: string, reason: string, estimate: number, fitNote = '',
) {
  const { fallbackCounts, handoffRoots, forcedThisTurn, notBefore, forceNotices } = state;
  let visible: number | undefined;
  try {
    const tokens = (await $.session.usage()).context.tokens;
    if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0) visible = tokens;
  } catch { /* Force is reason-driven even when actual usage is unavailable. */ }
  await countFallback($, fallbackCounts, 'reduction_ratio', configured.logDecisions);
  await writeSkipMarker($, handoffRoots, configured, reason, estimate, visible);
  let forced = false;
  if (sid && configured.handoffDir) {
    forcedThisTurn.add(sid);
    if (visible !== undefined) notBefore.set(sid, visible + PRUNE_HYSTERESIS_TOKENS);
    try {
      const cwd = await resolvedCwd($);
      await handoffStep($, {
        sessionId: sid, visible, forceReason: reason, requestOnly: true,
        config: { handoffAt: configured.handoffAt, handoffForceAt: configured.handoffForceAt,
          handoffDir: await handoffRoots.resolve(cwd, sid, configured.handoffDir, text => log($, text)),
          handoffSkillPath: await handoffRoots.resolve(cwd, sid, configured.handoffSkillPath, text => log($, text)) },
        log: text => log($, text),
        detach: work => { void work().catch(() => { /* The context remains intact on a host failure. */ }); },
      });
      forced = true;
    } catch { /* A failed store/capability cannot authorize a summary or clear. */ }
  }
  if (!forceNotices.has(sid)) {
    forceNotices.add(sid);
    const flag = await autoCompactFlag($);
    await notify($, `prune skipped (${reason}); context left as it is, built-in summary not requested; ${forced ? 'written handoff forced' : 'forced handoff could not be queued, context retained'}${fitNote}; hook=${HOOK_ID}; DISABLE_AUTO_COMPACT=${flag}`);
  }
  return { skip: `Jev ${reason}; context left as it is, built-in summary not requested; written handoff required` };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  const ledgers = new Map<string, FidelityLedger>();
  const ledgerFor = (sid: string): FidelityLedger => {
    let ledger = ledgers.get(sid);
    if (!ledger) { ledger = new FidelityLedger(); ledgers.set(sid, ledger); }
    return ledger;
  };
  const fallbackCounts = new Map<string, number>();
  const handoffRoots = createHandoffRoots();
  const loadedSessions = new Set<string>();
  try {
    (on as unknown as DeliveryOn)('session.append', async ($, event, next) => {
      await loadedReceipt($ as unknown as LogHost, loadedSessions);
      let sid = '';
      try { sid = await $.session.id(); } catch { /* legacy host */ }
      const ledger = ledgerFor(sid);
      // All doors supply UUID chronology; only deliveries become pinned rows.
      // $.session.messages is main-only: never use it to place a child's row.
      let snapshot: SessionMessage[] = [];
      try {
        if (event.agentId === undefined && event.door === 'delivery') snapshot = await $.session.messages();
      } catch { /* Observation must never block an append. UUID anchors remain usable. */ }
      const result = await next(event);
      if (!('deny' in result)) ledger.append({ ...event, ...result }, snapshot);
      return result;
    });
  } catch {
    // Observer absence alone is not evidence that a particular cut is unsafe.
  }

  on('prompt.submit', async ($, event, next) => {
    await loadedReceipt($, loadedSessions);
    let sid = '';
    try { sid = await $.session.id(); } catch { /* legacy host */ }
    const ledger = ledgerFor(sid);
    let snapshot: SessionMessage[] = [];
    try { snapshot = await $.session.messages(); } catch { /* Keep submission flowing. */ }
    const position = ledger.position();
    const result = await next(event);
    if (result.drop === undefined) {
      ledger.prompt(result.text, result.context ?? [], !!event.attachments?.length, snapshot, position, result.origin ?? event.origin);
    }
    return result;
  });

  let supportsCompaction = false;
  let lastPostCut: number | undefined;
  const notBefore = new Map<string, number>();
  const forcedThisTurn = new Set<string>();
  const forceNotices = new Set<string>();
  const ratioMissState: RatioMissState = { fallbackCounts, handoffRoots, forcedThisTurn, notBefore, forceNotices };
  try { on('session.compact', async ($, event) => {
    await loadedReceipt($, loadedSessions);
    // Precompute is speculative: no history is installed here. A success toast
    // was both misleading and a paid Jev call whose result could be discarded.
    if (event.trigger === 'precompute') return { skip: 'Jev runs when compaction is applied, not speculatively' };
    let sid = '';
    try { sid = await $.session.id(); } catch { /* legacy host: inline provenance */ }
    const ledger = ledgerFor(sid);
    // First event of a session id may be this one: capture the handoff root now (launch cwd).
    try {
      if (sid) await handoffRoots.resolve(await resolvedCwd($), sid, '.', text => log($, text));
    } catch { /* capture only */ }
    let prepared: SessionCompaction;
    let preparedCheckpoint = ledger.checkpoint();
    let fit: TargetFit | undefined;
    const storeKey = sid ? pinStoreKey(sid, event.agentId) : undefined;
    let storedPins: Pin[] = [];
    let externalPins = false;
    let pinReadFailed = false;
    if (storeKey) {
      try {
        const record = await $.store.get(storeKey);
        storedPins = readPinRecord(record);
        externalPins = true;
        // Absent means either a first migration or a lost external store. Legacy
        // inline pins are authoritative; without them protect user rows once.
        pinReadFailed = record === undefined && pinProvenanceTexts(event.messages).length === 0;
      } catch {
        // A prior cut may have moved its metadata off-transcript. Do not guess
        // which user rows were protected while that store is unreadable.
        pinReadFailed = true;
        await log($, 'pin storage unavailable; user rows protected, inline provenance retained');
      }
    }
    const projection = readPinProvenance(event.messages, storedPins).map(m =>
      pinReadFailed && m.role === 'user' && m.text.trim() ? { ...m, pinned: true } : m);
    const inputPins = collectPins(projection, new Set(projection.flatMap((m, i) => m.pinned ? [i] : [])));
    const originalChars = event.messages.reduce((n, m) => n + messageChars(m), 0);
    const projectedChars = projection.reduce((n, m) => n + messageChars(m), 0);
    // Include the bookkeeping actually being removed, plus net recovered text.
    const charsBefore = (rows: readonly Message[]): number => originalChars + Math.max(0,
      rows.reduce((n, m) => n + messageChars(m), 0) - projectedChars);
    let input: Message[] = projection;
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      // The actual host exposes rendered queued rows in its API-tail view. It
      // also accepts agentId; $.session.messages() without it is main-only.
      // Feature-detect by shape so older hosts/visible-only fixtures still use
      // the observer path, never a blanket startup summary.
      let apiHistory: unknown;
      try { apiHistory = await ($.session.messages as unknown as RuntimeMessages)({ as: 'api', agentId: event.agentId }); }
      catch { await log($, 'fidelity: API history unavailable; observable transcript order used'); }
      recoverApiHistory(apiHistory, projection, ledger, event.agentId, pinProvenanceTexts(event.messages));
      input = ledger.prepare(projection, event.agentId);
      for (const note of ledger.takeNotes()) await logFidelity($, note);
      if (!config.apiKey) throw new JevRequestError('TYPESAFE_API_KEY is not configured');
      const asker = jevAsker(async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        }, config.apiKey, config.model, async ms => { await $.clock.sleep(ms); });
      const first = await compact(input, asker, config);
      const refreshed = ledger.prepare(projection, event.agentId);
      const refreshedCheckpoint = ledger.checkpoint();
      // Turns a scored result into the actual replacement: late deliveries restored,
      // fresh handleless rows, with inline pins only on storage failure.
      const finalize = (scored: CompactResult): SessionCompaction => {
        const restored = ledger.restore(refreshed, scored.messages);
        const pins = new Set<number>();
        const policies = new Map<number, Message['notificationText']>();
        const rebuilt = toSessionMessages(event.messages, restored, pins, policies);
        const entries = collectPins(rebuilt, pins, policies);
        const rows = externalPins ? rebuilt : appendPinProvenance(rebuilt, entries);
        return {
          result: { ...scored, messages: restored, stats: { ...scored.stats, messagesBefore: refreshed.length,
            messagesAfter: restored.length, charsBefore: charsBefore(refreshed), charsAfter: rows.reduce((n, m) => n + messageChars(m), 0) } },
          messages: rows,
          pins: entries,
        };
      };
      let chosen = first;
      // The target loop is part of the hybrid; other sessions keep the 0.4.4 cut at keepThreshold.
      if (configured.targetVisibleTokens > 0 && await hybridSession($)) {
        fit = fitTarget(input, first, config, configured.targetVisibleTokens, scored => estimateSessionTokens(finalize(scored).messages));
        chosen = fit.result;
      }
      prepared = finalize(chosen);
      preparedCheckpoint = refreshedCheckpoint;
    } catch (error) {
      if (await hybridSession($)) {
        // The User, 2026-10-14 18:59: with Jev unavailable the hybrid never cuts blind; it skips,
        // marks the reason, and the handoff machine (system B) takes over at handoffAt/handoffForceAt.
        const reason = `Jev unavailable (${recoveryReason(error)})`;
        await notify($, `prune skipped (${reason}); no blind cut, the handoff takes over at ${configured.handoffAt}/${configured.handoffForceAt} tokens`);
        await countFallback($, fallbackCounts, 'jev_unavailable', configured.logDecisions);
        await writeSkipMarker($, handoffRoots, configured, reason, estimateSessionTokens(projection));
        return { skip: `${reason}; context left as it is, handoff takes over` };
      }
      await log($, `Jev transcript recovery (${recoveryReason(error)})`);
      // Include deliveries that arrived while a failed request was in flight.
      input = ledger.prepare(projection, event.agentId);
      const recoveryCheckpoint = ledger.checkpoint();
      for (const note of ledger.takeNotes()) await logFidelity($, note);
      const result = compactTranscript(input, configured);
      result.stats.charsBefore = charsBefore(input);
      const pins = new Set<number>();
      const policies = new Map<number, Message['notificationText']>();
      const rebuilt = toSessionMessages(event.messages, result.messages, pins, policies);
      const entries = collectPins(rebuilt, pins, policies);
      prepared = { result, messages: externalPins ? rebuilt : appendPinProvenance(rebuilt, entries), pins: entries };
      preparedCheckpoint = recoveryCheckpoint;
    }
    const { result } = prepared;
    let messages = prepared.messages;
    // Save before returning a handleless history. Keep old fingerprints until the
    // session is retired so rejection of a prepared cut cannot erase old pins.
    // A failed write/read-back retains legacy metadata in the returned history.
    result.stats.charsAfter = messages.reduce((n, m) => n + messageChars(m), 0);
    if (externalPins && storeKey && reductionRatio(result) >= configured.minReductionRatio) {
      const pins = mergePins(storedPins, inputPins, prepared.pins ?? []);
      if (pins.length) {
        try {
          await $.store.set(storeKey, { version: 2, pins });
          const verified = readPinRecord(await $.store.get(storeKey));
          if (JSON.stringify(verified) !== JSON.stringify(pins)) throw new Error('Pin write verification failed');
        } catch {
          messages = appendPinProvenance(messages, prepared.pins ?? []);
          await log($, 'pin storage write failed; inline provenance retained for this cut');
        }
      }
    }
    // The gate measures the actual replacement, including pin provenance.
    result.stats.charsAfter = messages.reduce((n, m) => n + messageChars(m), 0);
    if (configured.logDecisions) for (const line of decisionLogLines(result)) await log($, line);
    const post = estimateSessionTokens(messages);
    if (configured.maxPostCompactTokens > 0 && post > configured.maxPostCompactTokens) {
      await log($, `warn: estimated visible post-cut ~${post} tokens exceeds target ${configured.maxPostCompactTokens}; Jev replacement retained`);
    }
    const fitNote = fit
      ? `; target fit ~${fit.achieved} vs ${configured.targetVisibleTokens} tokens at keepThreshold ${fit.threshold}${fit.floorStage ? ' with lowered reply/injected minimums' : ''}, ${fit.reached ? 'reached' : 'NOT reached (floor above target)'} in ${fit.passes} re-pass(es)`
      : '';
    if (fit && !fit.reached) {
      await log($, `warn: unprunable floor ~${fit.achieved} tokens is above targetVisibleTokens ${configured.targetVisibleTokens}; best cut kept`);
    }
    // A ratio miss always forces a written handoff. ENV and token thresholds
    // cannot turn this into a built-in summary or delay the forced state.
    if (reductionRatio(result) < configured.minReductionRatio) {
      const reason = `reduction ${reductionRatio(result) * 100}% below ${configured.minReductionRatio * 100}% minimum`;
      return ratioMiss($ as unknown as SkipHost & HandoffHost, configured, ratioMissState, sid, reason, estimateSessionTokens(input), fitNote);
    }
    await notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result, post)}; visible target ${configured.maxPostCompactTokens || 'disabled'}${fitNote}; replacement prepared for ${event.trigger})`);
    // Persistence and diagnostics await host calls. A delivery accepted during
    // those awaits must be restored too. Finish synchronously with inline pins
    // rather than opening another persistence/arrival race; the next cut migrates them.
    if (ledger.checkpoint() !== preparedCheckpoint) {
      const refreshed = ledger.prepare(projection, event.agentId);
      const restored = ledger.restore(refreshed, result.messages);
      const pins = new Set<number>();
      const policies = new Map<number, Message['notificationText']>();
      const rebuilt = toSessionMessages(event.messages, restored, pins, policies);
      const lateMessages = appendPinProvenance(rebuilt, collectPins(rebuilt, pins, policies));
      const lateStats = { ...result.stats, charsBefore: charsBefore(refreshed),
        charsAfter: lateMessages.reduce((n, m) => n + messageChars(m), 0) };
      if (reductionRatio({ stats: lateStats }) < configured.minReductionRatio) {
        // Keep live history and late-arrival pins intact; never fall through to core.
        const reason = `late deliveries: reduction ${reductionRatio({ stats: lateStats }) * 100}% below ${configured.minReductionRatio * 100}% minimum`;
        return ratioMiss($ as unknown as SkipHost & HandoffHost, configured, ratioMissState, sid, reason, estimateSessionTokens(refreshed));
      }
      ledger.rebase(restored, event.agentId);
      if (event.agentId === undefined) lastPostCut = estimateSessionTokens(lateMessages);
      return { messages: lateMessages };
    }
    ledger.rebase(result.messages, event.agentId);
    if (event.agentId === undefined) lastPostCut = post;
    return { messages };
  }); supportsCompaction = true; } catch {
    // No supported installation surface exists without this event. Never call
    // the host compactor here: it would invoke the forbidden built-in summary.
  }

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    await loadedReceipt($, loadedSessions);
    if (compacting || event.agentId !== undefined) return next(event);
    let ownsCompaction = false;
    let hybrid = false;
    let visible: number | undefined;
    let sid: string | undefined;
    try { sid = await $.session.id(); } catch { sid = undefined; }
    hybrid = await hybridSession($);
    try {
      const { context } = await $.session.usage();
      const tokens = context.tokens;
      visible = tokens;
      const hold = sid ? notBefore.get(sid) : undefined;
      // Hybrid session with compactAtTokens > 0: compare context.tokens. Any other session, an
      // unset trigger (0) or an unreadable count: the 0.4.4 percent path.
      const due = hybrid && configured.compactAtTokens > 0 && tokens !== undefined
        ? tokens >= configured.compactAtTokens
        : (context.percent ?? 0) >= configured.compactAtPercent;
      if (compacting || !due || (sid && forcedThisTurn.has(sid)) || (hold !== undefined && (tokens ?? 0) < hold)) { /* no prune this turn */ }
      else {
        compacting = true;
        ownsCompaction = true;
        if (!supportsCompaction) {
          await notify($, 'Jev cannot install replacement: host has no session.compact event; built-in summary not requested');
        } else {
          lastPostCut = undefined;
          const outcome = await $.session.compact();
          if (outcome.skip === undefined) {
            const post = lastPostCut ?? outcome.tokensAfter;
            if (post !== undefined) { visible = post; if (sid) notBefore.set(sid, post + PRUNE_HYSTERESIS_TOKENS); }
            if (outcome.tokensAfter !== undefined) {
              await log($, `applied compaction: ${outcome.tokensBefore ?? '?'} -> ${outcome.tokensAfter} tokens (engine measurement)`);
            }
          } else if (sid) notBefore.set(sid, (tokens ?? 0) + PRUNE_HYSTERESIS_TOKENS);
        }
      }
    } catch (error) {
      await log($, 'auto-compact skipped (engine rejected the request; details omitted)');
    } finally {
      if (ownsCompaction) compacting = false;
    }
    // Token-threshold orders remain opt-in. A ratio-forced cycle always continues,
    // including when ENV or usage is unreadable. Interrupts never inject another order.
    const justForced = sid ? forcedThisTurn.delete(sid) : false;
    if (configured.handoffDir && sid && event.isAborted !== true) {
      try {
        const cwdNow = await resolvedCwd($);
        await handoffStep($ as unknown as HandoffHost, {
          sessionId: sid, visible, thresholdsEnabled: hybrid, repeatForced: !justForced,
          config: { handoffAt: configured.handoffAt, handoffForceAt: configured.handoffForceAt,
            handoffDir: await handoffRoots.resolve(cwdNow, sid, configured.handoffDir, text => log($, text)),
            handoffSkillPath: await handoffRoots.resolve(cwdNow, sid, configured.handoffSkillPath, text => log($, text)) },
          log: text => log($, text),
          detach: work => { void work().catch(() => { /* the work logs its own failures */ }); },
          onIdChanged: (previous, id) => handoffRoots.seed(previous, id),
        });
      } catch { await log($, 'handoff step failed (details omitted); pruning goes on'); }
    }
    return next(event);
  });
};

export { resolveOptions };
