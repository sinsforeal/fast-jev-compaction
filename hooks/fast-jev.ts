import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { estimateTokens } from '../src/state.js';
import type { DeliveryOn } from './runtime-contract.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  isRetryableStatus,
  parseJevResponse,
  JevHttpError,
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
  maxPostCompactTokens: 80_000,
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
        const response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
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

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const asker = jevAsker(fetchFn, config.apiKey, config.model, sleep);
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
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
  }; estimated visible post-cut ~${estimateSessionTokens(result.messages)} tokens; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
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

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let coreRequired: string | undefined = 'first cut after start/reload preserves legacy queued prompts and hidden content';
  let safetyGeneration = 0;
  let observesDeliveries = false;
  try {
    (on as unknown as DeliveryOn)('session.append', { door: 'delivery' }, async (_$, event, next) => {
      if (event.agentId === undefined && event.message.type === 'attachment') {
        safetyGeneration += 1;
        coreRequired = 'hidden delivery requires the full original transcript';
      }
      return next(event);
    });
    observesDeliveries = true;
  } catch {
    // Older hosts cannot expose hidden deliveries. Keep core in charge safely.
  }

  on('prompt.submit', async ($, event, next) => {
    const result = await next(event);
    if (result.drop === undefined && (event.turnId !== undefined || event.attachments?.length)) {
      safetyGeneration += 1;
      coreRequired = 'accepted queued prompt or non-text submission requires the full original transcript';
    }
    return result;
  });

  on('session.compact', async ($, event, next) => {
    // Precompute is speculative: no history is installed here. A success toast
    // was both misleading and a paid Jev call whose result could be discarded.
    if (event.trigger === 'precompute') return { skip: 'Jev runs when compaction is applied, not speculatively' };
    const fallback = async (reason: string) => {
      notify($, `fallback to built-in summary (${reason})`);
      const generation = safetyGeneration;
      const result = await next(event); // keep the original handles for core
      if (event.agentId === undefined && result.skip === undefined && generation === safetyGeneration) coreRequired = undefined;
      return result;
    };
    // Subagent projections do not expose their queued attachments to this main
    // prompt observer either; let core preserve their complete input.
    if (event.agentId !== undefined) return fallback('subagent compaction requires its full original transcript');
    if (!observesDeliveries) return fallback('host cannot observe hidden deliveries safely');
    if (coreRequired) return fallback(coreRequired);
    let prepared: SessionCompaction;
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      prepared = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        async (ms) => {
          await $.clock.sleep(ms);
        },
      );
    } catch (error) {
      return fallback(error instanceof JevHttpError ? `Jev HTTP ${error.status}` : 'Jev preparation failed; details omitted');
    }
    const { result, messages } = prepared;
    if (configured.logDecisions) for (const line of decisionLogLines(result)) $.ui.log(line);
    const post = estimateSessionTokens(messages);
    if (configured.maxPostCompactTokens > 0 && post > configured.maxPostCompactTokens) {
      return fallback(`estimated visible post-cut ~${post} tokens exceeds ${configured.maxPostCompactTokens} target`);
    }
    if (reductionRatio(result) < configured.minReductionRatio) {
      return fallback(`below ${percent(configured.minReductionRatio)} minimum: ${summarize(result)}`);
    }
    // A prompt accepted while Jev was in flight must not vanish in a stale cut.
    if (coreRequired) return fallback(coreRequired);
    notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)}; replacement prepared for ${event.trigger})`);
    return { messages };
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting || event.agentId !== undefined) return next(event);
    let ownsCompaction = false;
    try {
      const { context } = await $.session.usage();
      if (compacting || (context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      ownsCompaction = true;
      const outcome = await $.session.compact();
      if (outcome.skip === undefined && outcome.tokensAfter !== undefined) {
        $.ui.log(`applied compaction: ${outcome.tokensBefore ?? '?'} -> ${outcome.tokensAfter} tokens (engine measurement)`);
      }
    } catch (error) {
      $.ui.log(
        'auto-compact skipped (engine rejected the request; details omitted)',
      );
    } finally {
      if (ownsCompaction) compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
