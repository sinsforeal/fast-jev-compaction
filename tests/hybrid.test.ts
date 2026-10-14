import { describe, expect, it, vi } from 'vitest';
import { register, resolveHookConfig, estimateSessionTokens } from '../hooks/fast-jev.ts';
import { handoffStep, checkLatest, type HandoffHost, type StepContext } from '../hooks/handoff.ts';
import { compact, fitTarget, thresholdLadder, type JevAsker, type Message } from '../src/index.js';

const m = (role: Message['role'], text: string, extra = {}): Message => ({ role, text, toolUses: [], ...extra });

// ---- target loop -------------------------------------------------------------
function longSession(): Message[] {
  const rows: Message[] = [m('user', 'task')];
  for (let i = 0; i < 10; i++) {
    rows.push(m('assistant', '', { toolUses: [{ tool_use_id: `u${i}`, tool: 'Read', input: { i } }] }));
    rows.push(m('user', '', { toolResults: [{ tool_use_id: `u${i}`, text: `row${i} `.repeat(2000) }] }));
  }
  rows.push(m('assistant', 'long reply '.repeat(300)), m('user', 'go'), m('assistant', 'end'));
  return rows;
}
// call i is kept with probability 0.5 + 0.045 * i (result), so a rising threshold drops them oldest first.
const graded: JevAsker = { async ask(_s, q) {
  const answers: Record<string, { noul: number }> = {};
  for (const key of Object.keys(q)) {
    const n = Number(/(\d+)$/.exec(key)?.[1] ?? 1);
    answers[key] = { noul: key.startsWith('text') ? 0.6 : key.startsWith('call') ? 0.99 : 0.5 + 0.045 * n };
  }
  return { answers } as any;
} };

describe('target loop', () => {
  const est = (r: { messages: Message[] }) => estimateSessionTokens(r.messages);
  it('raises the threshold over cached answers until the target is met, with no new request', async () => {
    const rows = longSession();
    const ask = vi.spyOn(graded, 'ask');
    const first = await compact(rows, graded, { preserveRecentMessages: 2, keepThreshold: 0.5 });
    const calls = ask.mock.calls.length;
    const target = Math.floor(est(first) * 0.6);
    const fit = fitTarget(rows, first, { preserveRecentMessages: 2, keepThreshold: 0.5 }, target, est);
    expect(fit.reached).toBe(true);
    expect(fit.achieved).toBeLessThanOrEqual(target);
    expect(fit.threshold).toBeGreaterThan(0.5);
    expect(fit.floorStage).toBe(false);
    expect(ask.mock.calls.length).toBe(calls);
  });
  it('stops at the floor when the target is below it, after lowering the minimums once', async () => {
    const rows = longSession();
    const first = await compact(rows, graded, { preserveRecentMessages: 2 });
    const fit = fitTarget(rows, first, { preserveRecentMessages: 2 }, 10, est);
    expect(fit.reached).toBe(false);
    expect(fit.floorStage).toBe(true);
    expect(fit.threshold).toBe(1.0001);
    expect(fit.achieved).toBeGreaterThan(10);
  });
  it('ladder ends just past 1', () => { expect(thresholdLadder(0.9)).toEqual([0.95, 1, 1.0001]); });
});

// ---- options -----------------------------------------------------------------
describe('options', () => {
  it('parses the 0.5.0 options and raises force to at', () => {
    const c = resolveHookConfig({ compactAtTokens: 100000, targetVisibleTokens: 50000, handoffAt: 200000, handoffForceAt: 100, handoffDir: 'F:\\h', handoffSkillPath: 'S.md' });
    expect(c).toMatchObject({ compactAtTokens: 100000, targetVisibleTokens: 50000, handoffAt: 200000, handoffForceAt: 200000, handoffDir: 'F:\\h', handoffSkillPath: 'S.md' });
    expect(resolveHookConfig({ compactAtTokens: 0 }).compactAtTokens).toBe(0);
  });
});

// ---- hook: skip path, log prefix, trigger precedence --------------------------
const SID = 'abcdef12-0000-4000-8000-000000000000';
function harness(options = {}, tokens: number | undefined = 200000, hybrid = true) {
  const handlers: Record<string, Function> = {};
  register(((name: string, ...a: any[]) => { handlers[name] = a.at(-1); }) as any, { apiKey: 'f', preserveRecentMessages: 1, ...options });
  const files = new Map<string, string>(); const logs: string[] = [];
  const rows = [m('user', 'task', { handle: 'u' }), m('assistant', 'fact'), m('user', 'continue')];
  const $: any = { env: { get: async (k: string) => k === 'DISABLE_AUTO_COMPACT' ? (hybrid ? '1' : undefined) : 'F:/temp/x' }, settings: { read: async () => ({}) },
    fs: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p) ?? '', write: async (p: string, t: string) => { files.set(p, t); } },
    http: { fetch: vi.fn(async (_u: string, init: any) => ({ status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(k => [k, { noul: 1 }])) }) })) },
    clock: { sleep: async () => {}, now: async () => 1000 }, ui: { log: (s: string) => logs.push(s), toast: vi.fn() },
    session: { id: async () => SID, usage: vi.fn(async () => ({ context: { tokens, percent: 1 } })), messages: async () => rows, compact: vi.fn(async () => ({ messages: [] })) } };
  return { handlers, files, logs, $, rows };
}
describe('hook', () => {
  it('a ratio miss returns skip, writes prune_skipped.json, never calls next, prefixes the log', async () => {
    const h = harness({ minReductionRatio: 1, handoffDir: 'F:/handoffs' });
    const next = vi.fn();
    const out = await h.handlers['session.compact'](h.$, { trigger: 'plugin', messages: h.rows }, next);
    expect(out.skip).toContain('built-in summary not requested');
    expect(next).not.toHaveBeenCalled();
    const marker = JSON.parse(h.files.get(`F:/handoffs/${SID}/prune_skipped.json`)!);
    expect(marker).toMatchObject({ tokens: 200000 });
    expect(marker.reason).toContain('below 100% minimum');
    expect(typeof marker.estimate).toBe('number');
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.every(l => l.startsWith('[abcdef12] '))).toBe(true);
  });
  it('session.compact with targetVisibleTokens returns a replacement at or under the target and never calls next', async () => {
    const target = 6000;
    const h = harness({ targetVisibleTokens: target, preserveRecentMessages: 2, keepThreshold: 0.5 });
    const rows: Message[] = [m('user', 'task', { handle: 'u0' })];
    for (let i = 0; i < 10; i++) {
      rows.push(m('assistant', '', { handle: `c${i}`, toolUses: [{ tool_use_id: `u${i}`, tool: 'Read', input: { i } }] }));
      rows.push(m('user', '', { handle: `r${i}`, toolResults: [{ tool_use_id: `u${i}`, text: `row${i} `.repeat(2000) }] }));
    }
    rows.push(m('assistant', 'end', { handle: 'a' }), m('user', 'go', { handle: 'u1' }));
    // every answer keeps its item at the base threshold, so only the target loop can shrink the cut
    h.$.http.fetch = vi.fn(async (_u: string, init: any) => ({ status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(
      Object.keys(JSON.parse(init.body).questions).map(k => [k, { noul: k.startsWith('call') ? 0.99 : 0.5 + 0.045 * Number(/(\d+)$/.exec(k)?.[1] ?? 1) }])) }) }));
    expect(estimateSessionTokens(rows)).toBeGreaterThan(target);
    const next = vi.fn();
    const out = await h.handlers['session.compact'](h.$, { trigger: 'plugin', messages: rows }, next);
    expect(next).not.toHaveBeenCalled();
    expect(out.skip).toBeUndefined();
    expect(estimateSessionTokens(out.messages)).toBeLessThanOrEqual(target);
    expect(h.$.http.fetch).toHaveBeenCalledTimes(1);
    expect(h.logs.some(l => l.includes('target fit') && l.includes('reached'))).toBe(true);
  });
  it('compactAtTokens replaces the percent trigger; percent path when it is 0', async () => {
    const a = harness({ compactAtTokens: 150000 }, 120000); await a.handlers['turn.complete'](a.$, {}, async (e: any) => e);
    expect(a.$.session.compact).not.toHaveBeenCalled();
    const b = harness({ compactAtTokens: 150000 }, 160000); await b.handlers['turn.complete'](b.$, {}, async (e: any) => e);
    expect(b.$.session.compact).toHaveBeenCalledTimes(1);
    const c = harness({ compactAtTokens: 0, compactAtPercent: 50 }, 900000); c.$.session.usage = async () => ({ context: { tokens: 900000, percent: 90 } });
    await c.handlers['turn.complete'](c.$, {}, async (e: any) => e);
    expect(c.$.session.compact).toHaveBeenCalledTimes(1);
  });
  it('without DISABLE_AUTO_COMPACT=1 the hook keeps 0.4.4 behaviour: percent trigger, ratio miss falls through to next, no handoff', async () => {
    const a = harness({ compactAtTokens: 150000, handoffDir: 'F:/handoffs' }, 300000, false);
    await a.handlers['turn.complete'](a.$, {}, async (e: any) => e);
    expect(a.$.session.compact).not.toHaveBeenCalled();
    expect([...a.files.keys()].some(k => k.startsWith('F:/handoffs/'))).toBe(false);
    const b = harness({ minReductionRatio: 1, handoffDir: 'F:/handoffs', targetVisibleTokens: 6000 }, 200000, false);
    const next = vi.fn(async () => ({ summary: true }));
    const out = await b.handlers['session.compact'](b.$, { trigger: 'auto', messages: b.rows }, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ summary: true });
    expect(b.files.has(`F:/handoffs/${SID}/prune_skipped.json`)).toBe(false);
    expect(b.logs.some(l => l.includes('fallback to built-in summary'))).toBe(true);
    expect(b.logs.some(l => l.includes('target fit'))).toBe(false);
  });
  it('Jev unavailable: a hybrid session skips with a marker and leaves the cut to the handoff; another session keeps the recovery cut', async () => {
    const h = harness({ handoffDir: 'F:/handoffs' });
    h.$.http.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const next = vi.fn();
    const out = await h.handlers['session.compact'](h.$, { trigger: 'plugin', messages: h.rows }, next);
    expect(out.skip).toContain('Jev unavailable');
    expect(next).not.toHaveBeenCalled();
    const marker = JSON.parse(h.files.get(`F:/handoffs/${SID}/prune_skipped.json`)!);
    expect(marker.reason).toContain('Jev unavailable');
    expect(h.logs.some(l => l.includes('handoff takes over'))).toBe(true);
    const o = harness({}, 200000, false);
    o.$.http.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const cut = await o.handlers['session.compact'](o.$, { trigger: 'auto', messages: o.rows }, vi.fn());
    expect(cut.skip).toBeUndefined();
    expect(Array.isArray(cut.messages)).toBe(true);
    expect(o.logs.some(l => l.includes('transcript recovery'))).toBe(true);
  });
});

// ---- handoff state machine ---------------------------------------------------
const DIR = 'F:/handoffs';
const LATEST = `${DIR}/${SID}/latest.md`;
function machine() {
  const files = new Map<string, string>(); const mtimes = new Map<string, number>(); const store = new Map<string, unknown>();
  const submits: string[] = []; const runs: string[] = []; const logs: string[] = []; let now = 1000; let id = SID; let clearFails = false;
  const host: HandoffHost = {
    session: { id: async () => id },
    clock: { now: async () => now, sleep: async () => {} },
    fs: { exists: async p => files.has(p), read: async p => files.get(p)!, write: async (p, t) => { files.set(p, t); mtimes.set(p, now); },
      stat: async p => ({ kind: 'file', size: 1, mtimeMs: mtimes.get(p)! }) },
    store: { get: async k => store.get(k), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async k => { store.delete(k); } },
    prompt: { submit: async ({ text }) => { submits.push(text); } },
    command: { run: async ({ command }) => { if (clearFails) throw new Error('no'); runs.push(command); id = 'new-session-id'; } },
  };
  const pending: Promise<void>[] = [];
  const step = async (visible: number) => {
    const ctx: StepContext = { host, sessionId: SID, visible, log: async t => { logs.push(t); }, detach: w => { pending.push(w()); },
      config: { handoffAt: 250000, handoffForceAt: 300000, handoffDir: DIR, handoffSkillPath: 'docs/HANDOFF_SKILL.md' } };
    await handoffStep(ctx.host, ctx); await Promise.all(pending.splice(0));
  };
  const write = (body: string) => { now += 10; files.set(LATEST, body); mtimes.set(LATEST, now); };
  return { step, files, submits, runs, logs, store, write, tick: (n: number) => { now += n; }, failClear: (v: boolean) => { clearFails = v; } };
}
const good = `# Handoff for session ${SID}\nbody\nCOMPLETE\n`;

describe('handoff state machine', () => {
  it('soon once per 50k of growth, then force', async () => {
    const t = machine();
    await t.step(240000); expect(t.submits).toEqual([]);
    await t.step(250000); expect(t.submits).toHaveLength(1);
    expect(t.submits[0]).toContain(`HANDOFF SOON: unprunable context is 250000 tokens (limit 300000)`);
    expect(t.submits[0]).toContain(`write ${LATEST} ending with the line COMPLETE. Do not start new work.`);
    await t.step(280000); expect(t.submits).toHaveLength(1);
    await t.step(300000); expect(t.submits).toHaveLength(2);
    expect(t.submits[1]).toContain('HANDOFF NOW');
    expect(t.submits[1]).toContain('cleared and resumed by the plugin');
  });
  it('a complete file for this session clears, writes resumed.json first, then submits the resume', async () => {
    const t = machine();
    await t.step(310000); t.write(good);
    await t.step(310000);
    expect(t.runs).toEqual(['clear']);
    const resumed = JSON.parse(t.files.get(`${DIR}/${SID}/resumed.json`)!);
    expect(resumed).toMatchObject({ by: 'plugin', file: LATEST });
    expect(typeof resumed.mtime).toBe('number');
    expect(t.submits.at(-1)).toBe(`HANDOFF RESUME: read ${LATEST} and follow docs/HANDOFF_SKILL.md section Resume; verify every SHA and queue row against git before acting.`);
    expect(JSON.parse(t.files.get(`${DIR}/current_session.json`)!)).toMatchObject({ id: 'new-session-id', previous_id: SID });
    expect(t.files.get(`${DIR}/new-session-id/latest.md`)).toBe(good);
    expect(t.logs.join('\n')).toContain('session id CHANGED');
    expect(t.store.has(`handoff:${SID}`)).toBe(false);
  });
  it('wrong session, missing COMPLETE, or older file never clears; the order repeats at most 3 times', async () => {
    const t = machine();
    await t.step(310000);
    t.write(`# Handoff for session other-id\nCOMPLETE\n`); await t.step(310000);
    t.write(`# Handoff for session ${SID}\nbody\n`); await t.step(310000);
    await t.step(310000); await t.step(310000); await t.step(310000);
    expect(t.runs).toEqual([]);
    expect(t.submits.filter(s => s.startsWith('HANDOFF NOW'))).toHaveLength(4); // 1 + 3 repeats
    expect(t.logs.join('\n')).toContain('handoff not written');
    const before = t.submits.length; await t.step(310000); expect(t.submits.length).toBe(before);
  });
  it('a stale complete file older than the order does not count', async () => {
    const t = machine(); t.write(good); t.tick(100);
    await t.step(310000); await t.step(310000);
    expect(t.runs).toEqual([]);
    expect((await checkLatest({ fs: { exists: async () => true, stat: async () => ({ kind: 'file', size: 1, mtimeMs: 5 }), read: async () => good, write: async () => {} } }, LATEST, SID, 5)).ok).toBe(false);
  });
  it('a failed clear is retried on later turns without a resume submit', async () => {
    const t = machine(); await t.step(310000); t.write(good); t.failClear(true);
    await t.step(310000); expect(t.submits.some(s => s.startsWith('HANDOFF RESUME'))).toBe(false);
    t.failClear(false); await t.step(310000); expect(t.runs).toEqual(['clear']);
  });
});
