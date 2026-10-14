import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { applyDecisions, compact, decideCall, messageChars, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import type { DeliveryOn } from './runtime-contract.js';
import { FidelityLedger } from './fidelity.js';
import { recoverApiHistory, type RuntimeMessages } from './api-history.js';
import { readPinProvenance, persistPinProvenance, pinProvenanceTexts } from './pin-provenance.js';
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
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  logDecisions: false,
  maxPostCompactTokens: 0,
};

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
    if (message.pinned && message.role === 'user') pinned?.add(rebuiltMessages.length - 1);
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

async function log($: LogHost, text: string): Promise<void> {
  await appendLog($, text);
  try { $.ui.log(text); } catch { /* UI failure cannot change compaction. */ }
}

async function notify($: LogHost, text: string): Promise<void> {
  await appendLog($, text);
  try { $.ui.log(text); } catch { /* UI failure cannot change compaction. */ }
  try { $.ui.toast(text, { timeoutMs: 15_000 }); } catch { /* Disk receipt already written. */ }
}

function countFallback(
  $: { ui: { log: (s: string) => void } },
  counts: Map<string, number>, reason: string, enabled: boolean,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  if (enabled) try { $.ui.log(`fallback counts: ${Array.from(counts, ([r, n]) => `${r}=${n}`).join(' ')}`); } catch { /* diagnostic only */ }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  const ledger = new FidelityLedger();
  const fallbackCounts = new Map<string, number>();
  try {
    (on as unknown as DeliveryOn)('session.append', async ($, event, next) => {
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
    const relevant = event.turnId !== undefined || !!event.attachments?.length;
    let snapshot: SessionMessage[] = [];
    try { if (relevant) snapshot = await $.session.messages(); } catch { /* Keep submission flowing. */ }
    const position = ledger.position();
    const result = await next(event);
    if (result.drop === undefined && relevant) {
      ledger.prompt(result.text, result.context ?? [], !!event.attachments?.length, snapshot, position, result.origin ?? event.origin);
    }
    return result;
  });

  let supportsCompaction = false;
  try { on('session.compact', async ($, event, next) => {
    // Precompute is speculative: no history is installed here. A success toast
    // was both misleading and a paid Jev call whose result could be discarded.
    if (event.trigger === 'precompute') return { skip: 'Jev runs when compaction is applied, not speculatively' };
    const fallback = async (code: string, reason: string) => {
      await notify($, `fallback to built-in summary (${reason})`);
      countFallback($, fallbackCounts, code, configured.logDecisions);
      const checkpoint = ledger.checkpoint();
      const result = await next(event); // keep the original handles for core
      if (result.skip === undefined) ledger.coreApplied(event.agentId, checkpoint);
      return result;
    };
    let prepared: SessionCompaction;
    const projection = readPinProvenance(event.messages);
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
      for (const note of ledger.takeNotes()) await log($, `fidelity: ${note}`);
      if (!config.apiKey) throw new JevRequestError('TYPESAFE_API_KEY is not configured');
      const asker = jevAsker(async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        }, config.apiKey, config.model, async ms => { await $.clock.sleep(ms); });
      const result = await compact(input, asker, config);
      const refreshed = ledger.prepare(projection, event.agentId);
      result.messages = ledger.restore(refreshed, result.messages);
      result.stats.messagesBefore = refreshed.length;
      result.stats.messagesAfter = result.messages.length;
      result.stats.charsBefore = refreshed.reduce((n, m) => n + messageChars(m), 0);
      result.stats.charsAfter = result.messages.reduce((n, m) => n + messageChars(m), 0);
      const pins = new Set<number>();
      prepared = { result, messages: persistPinProvenance(toSessionMessages(event.messages, result.messages, pins), pins) };
    } catch (error) {
      await log($, `Jev transcript recovery (${recoveryReason(error)})`);
      // Include deliveries that arrived while a failed request was in flight.
      input = ledger.prepare(projection, event.agentId);
      for (const note of ledger.takeNotes()) await log($, `fidelity: ${note}`);
      const result = compactTranscript(input, configured);
      const pins = new Set<number>();
      prepared = { result, messages: persistPinProvenance(toSessionMessages(event.messages, result.messages, pins), pins) };
    }
    const { result, messages } = prepared;
    // The gate measures the actual replacement, including pin provenance.
    result.stats.charsAfter = messages.reduce((n, m) => n + messageChars(m), 0);
    if (configured.logDecisions) for (const line of decisionLogLines(result)) await log($, line);
    const post = estimateSessionTokens(messages);
    if (configured.maxPostCompactTokens > 0 && post > configured.maxPostCompactTokens) {
      await log($, `warn: estimated visible post-cut ~${post} tokens exceeds target ${configured.maxPostCompactTokens}; Jev replacement retained`);
    }
    if (reductionRatio(result) < configured.minReductionRatio) {
      return fallback('reduction_ratio', `reduction below ${percent(configured.minReductionRatio)} minimum`);
    }
    await notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result, post)}; visible target ${configured.maxPostCompactTokens || 'disabled'}; replacement prepared for ${event.trigger})`);
    ledger.rebase(result.messages, event.agentId);
    return { messages };
  }); supportsCompaction = true; } catch {
    // No supported installation surface exists without this event. Never call
    // the host compactor here: it would invoke the forbidden built-in summary.
  }

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting || event.agentId !== undefined) return next(event);
    let ownsCompaction = false;
    try {
      const { context } = await $.session.usage();
      if (compacting || (context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      ownsCompaction = true;
      if (!supportsCompaction) {
        await notify($, 'Jev cannot install replacement: host has no session.compact event; built-in summary not requested');
        return next(event);
      }
      const outcome = await $.session.compact();
      if (outcome.skip === undefined && outcome.tokensAfter !== undefined) {
        await log($, `applied compaction: ${outcome.tokensBefore ?? '?'} -> ${outcome.tokensAfter} tokens (engine measurement)`);
      }
    } catch (error) {
      await log($, 'auto-compact skipped (engine rejected the request; details omitted)');
    } finally {
      if (ownsCompaction) compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
