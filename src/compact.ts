import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import { applyTextDecisions, collectTextBlocks, decideText, textCandidates, textQuestionsFor } from './text.js';
import { safeSlice } from './unicode.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
  TextBlock,
  TextAnswer,
  TextDecision,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  injectedMinChars: 1000,
  replyMinChars: 2000,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/**
 * Batches in flight at once. Every batch re-sends the full state, so a long session
 * fanned out unbounded is a burst of 100+ large POSTs, which an edge rate rule answers
 * with a 403 block page and the whole compaction falls back.
 */
export const MAX_CONCURRENT_REQUESTS = 4;

/** `Promise.all` over `items` with at most `limit` calls in flight; order is kept. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    injectedMinChars: Math.max(0, Math.floor(finite(options.injectedMinChars, DEFAULT_OPTIONS.injectedMinChars))),
    replyMinChars: Math.max(0, Math.floor(finite(options.replyMinChars, DEFAULT_OPTIONS.replyMinChars))),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  return batchItems(calls, questionsFor, stateTokens, options);
}

export function batchItems<T>(
  items: readonly T[],
  questionsOf: (item: T) => JevQuestions,
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): T[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  for (const call of items) {
    const tokens = estimateTokens(JSON.stringify(questionsOf(call)));
    if (tokens > budget) throw new Error('no room for Jev state and one question under maxRequestTokens');
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const retained = safeSlice(text, 0, headChars);
  const head = headChars > 0 ? `${retained}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - retained.length} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    const removed = message.toolUses.filter(tool => actions.get(tool.tool_use_id) === 'drop_call');
    const marker = removed.length > 0 ? `[fast-jev-compaction removed ${removed.length} tool call(s) and their results; earlier answers may rely on that evidence]` : '';
    if (message.text.trim().length === 0 && !marker && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { ...message, text: [message.text, marker].filter(Boolean).join('\n'), toolUses, toolResults: undefined };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly { reason: string }[], reason: string): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** Effective floor of `replyMinChars`: a reply must exceed head + tail + slack to be abridged. */
const REPLY_FLOOR_CHARS = 1100;
/** Effective floor of `injectedMinChars`: shorter blocks are never candidates. */
const INJECTED_FLOOR_CHARS = 200;

export type ReplanOverrides = {
  keepThreshold: number;
  replyMinChars?: number;
  injectedMinChars?: number;
  /** Probability given to a text block that became eligible only through lowered minimums. */
  unscoredKeep?: number;
};

const blockKey = (block: Pick<TextBlock, 'index' | 'start' | 'end' | 'kind'>): string =>
  `${block.index}:${block.start}:${block.end}:${block.kind}`;

/**
 * Re-runs the decide and apply steps over the probabilities `compact()` already
 * cached in `prior` (its decisions carry keepCall/keepResult, its text decisions
 * carry keep). No Jev request is made. A call or block without a cached answer is
 * kept as it is, so a recovery result (nothing scored) is never cut harder.
 * `messages` must be the exact input `compact()` ran over, with the same options.
 */
export function replan(
  messages: readonly Message[],
  prior: Pick<CompactResult, 'decisions' | 'textDecisions' | 'stats'>,
  options: CompactOptions,
  override: ReplanOverrides,
): CompactResult {
  const started = Date.now();
  const original = resolveOptions(options);
  const resolved: ResolvedCompactOptions = {
    ...original,
    keepThreshold: override.keepThreshold,
    replyMinChars: override.replyMinChars ?? original.replyMinChars,
    injectedMinChars: override.injectedMinChars ?? original.injectedMinChars,
  };
  const calls = collectToolCalls(messages, original.preserveRecentMessages);
  const cached = new Map(prior.decisions.map(d => [d.id, { keepCall: d.keepCall, keepResult: d.keepResult }]));
  const decisions: CallDecision[] = calls.map(call => {
    const answer = cached.get(call.id);
    if (!answer) {
      return { id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: 'keep',
        reason: call.pinned ? 'pinned' : 'kept' } as CallDecision;
    }
    return decideCall(call, answer, resolved);
  });

  const origBlocks = collectTextBlocks(messages, original);
  const answered = new Map<string, TextAnswer>();
  const knownKeys = new Set<string>();
  origBlocks.forEach((block, i) => {
    knownKeys.add(blockKey(block));
    const d = prior.textDecisions[i];
    if (d && (d.reason === 'kept' || d.reason === 'abridged' || d.reason === 'removed')) {
      answered.set(blockKey(block), { keep: d.keep });
    }
  });
  const blocks = collectTextBlocks(messages, resolved);
  const candidates = new Set(textCandidates(blocks, resolved).map(b => b.id));
  const textDecisions: TextDecision[] = blocks.map(block => {
    const key = blockKey(block);
    let answer = answered.get(key);
    if (!answer && override.unscoredKeep !== undefined && !knownKeys.has(key) && candidates.has(block.id)) {
      answer = { keep: override.unscoredKeep };
    }
    return decideText(block, answer, resolved);
  });
  const kept = applyDecisions(
    applyTextDecisions(messages, blocks, textDecisions),
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    textDecisions,
    stats: {
      ...prior.stats,
      messagesAfter: kept.length,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      texts: blocks.length,
      textsRemoved: count(textDecisions, 'removed'),
      duplicatesRemoved: count(textDecisions, 'duplicate'),
      repliesAbridged: count(textDecisions, 'abridged'),
      ms: prior.stats.ms + (Date.now() - started),
    },
  };
}

export type TargetFit = {
  result: CompactResult;
  /** keepThreshold of the returned result. */
  threshold: number;
  /** Estimated size of the returned result, as `estimate` measured it. */
  achieved: number;
  reached: boolean;
  /** True when replyMinChars and injectedMinChars were lowered to get there (or to try). */
  floorStage: boolean;
  passes: number;
};

/** Thresholds above `base`: steps of 0.05 up to 1, then one just past 1 (only probability 1.0 survives). */
export function thresholdLadder(base: number): number[] {
  const out: number[] = [];
  for (let k = 1; ; k++) {
    const t = Math.round((base + 0.05 * k) * 100) / 100;
    if (t > 1) break;
    out.push(t);
  }
  out.push(1.0001);
  return out;
}

/**
 * Aims `first` (the Jev pass at the configured keepThreshold) at a real post-cut
 * size: raises keepThreshold over the cached probabilities until `estimate` is at
 * or under `target` or the threshold has passed 1; if the unprunable floor is still
 * above the target, lowers replyMinChars and injectedMinChars once (blocks that
 * became eligible are abridged or removed unscored) and sweeps again. No Jev request.
 * Returns the best result reached; `reached` says whether the target was met.
 */
export function fitTarget(
  messages: readonly Message[],
  first: CompactResult,
  options: CompactOptions,
  target: number,
  estimate: (result: CompactResult) => number,
): TargetFit {
  const original = resolveOptions(options);
  let passes = 0;
  const firstSize = estimate(first);
  const done = (result: CompactResult, threshold: number, achieved: number, floorStage: boolean): TargetFit =>
    ({ result, threshold, achieved, reached: achieved <= target, floorStage, passes });
  if (firstSize <= target || (first.decisions.length === 0 && first.textDecisions.length === 0)) {
    return done(first, original.keepThreshold, firstSize, false);
  }
  let last = { result: first, threshold: original.keepThreshold, size: firstSize };
  const sweep = (extra: Partial<ReplanOverrides>): typeof last | undefined => {
    for (const threshold of thresholdLadder(original.keepThreshold)) {
      const result = replan(messages, first, options, { keepThreshold: threshold, ...extra });
      passes++;
      last = { result, threshold, size: estimate(result) };
      if (last.size <= target) return last;
    }
    return undefined;
  };
  const hit = sweep({});
  if (hit) return done(hit.result, hit.threshold, hit.size, false);
  const reply = original.replyMinChars > 0 ? Math.max(REPLY_FLOOR_CHARS, Math.floor(original.replyMinChars / 2)) : 0;
  const injected = original.injectedMinChars > 0 ? Math.max(INJECTED_FLOOR_CHARS, Math.floor(original.injectedMinChars / 2)) : 0;
  const floorHit = sweep({ replyMinChars: reply, injectedMinChars: injected, unscoredKeep: 0 });
  const best = floorHit ?? last;
  return done(best.result, best.threshold, best.size, true);
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const blocks = collectTextBlocks(messages, resolved);
  let textAsked = textCandidates(blocks, resolved);
  const unrepresented = new Set<string>();
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  const textAnswers = new Map<string, TextAnswer>();
  let textRequests = 0;
  if (candidates.length > 0 || textAsked.length > 0) {
    const state = fitState(messages, calls, resolved, blocks);
    const entries = new Map(state.state.history.map(entry => [entry.i, entry]));
    textAsked = textAsked.filter(block => {
      const entry = entries.get(block.index);
      const message = messages[block.index];
      if (!message) { unrepresented.add(block.id); return false; }
      const source = message.text.slice(block.start, block.end);
      const preview = safeSlice(source, 0, Math.min(60, source.length));
      const represented = entry !== undefined && entry.text.includes(preview) &&
        (block.kind === 'reply' ? entry.text_block === block.id : entry.text.includes(`[${block.id}:`));
      if (!represented) unrepresented.add(block.id);
      return represented;
    });
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await mapLimit(batches, MAX_CONCURRENT_REQUESTS, (batch) =>
      askBatch(asker, state.state, batch),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
    const textBatches = batchItems(textAsked, textQuestionsFor, state.tokens, resolved);
    textRequests = textBatches.length;
    const answeredTexts = await mapLimit(textBatches, MAX_CONCURRENT_REQUESTS, async batch => {
      const questions = Object.assign({}, ...batch.map(textQuestionsFor));
      const response = await asker.ask(state.state, questions);
      return batch.map(block => [block.id, { keep: noulAnswer(response.answers, `text_${block.id}`) }] as const);
    });
    for (const part of answeredTexts) for (const [id, answer] of part) textAnswers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const textDecisions: TextDecision[] = blocks.map(block => {
    const decision = decideText(block, textAnswers.get(block.id), resolved);
    return unrepresented.has(block.id) ? { ...decision, reason: 'unrepresented' } : decision;
  });
  const kept = applyDecisions(
    applyTextDecisions(messages, blocks, textDecisions),
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    textDecisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      texts: blocks.length,
      textsRemoved: count(textDecisions, 'removed'),
      duplicatesRemoved: count(textDecisions, 'duplicate'),
      repliesAbridged: count(textDecisions, 'abridged'),
      textsUnrepresented: unrepresented.size,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length + textRequests,
      ms: Date.now() - started,
    },
  };
}
