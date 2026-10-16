/**
 * 0.5.9: `/color <name>` is stored as an `agent-color` record in the session transcript. A clear
 * moves the conversation to a new transcript without it, so the prompt bar color is lost.
 * This reads the newest record of the outgoing transcript and re-applies it after the clear.
 * Nothing here throws: the handoff must never fail because of the color.
 */

export type ColorHost = {
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
  command: {
    run: (input: { command: string; args?: string }) => Promise<unknown>;
    list: () => Promise<readonly { name: string }[]>;
  };
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout?: string }> };
};

export type AgentColorRecord = { type: 'agent-color'; agentColor: string; [key: string]: unknown };

/** No `crypto` in the hook typings; a record uuid only has to be unique. */
const uuid4 = (): string => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

const onWindows =(): boolean => (globalThis as { process?: { platform?: string } }).process?.platform === 'win32';

/** `<home>/.claude/projects/<cwd with every non-alphanumeric run char as '-'>/<sid>.jsonl` */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return `${home.replace(/[\\/]+$/, '')}/.claude/projects/${slug}/${sessionId}.jsonl`;
}

/** The newest record in grep output (one JSON line per hit), scanning from the last line up. */
export function newestColor(stdout: string): AgentColorRecord | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.type === 'agent-color' && typeof rec.agentColor === 'string' && rec.agentColor) return rec as AgentColorRecord;
    } catch { /* a line that only mentions the word is not a record */ }
  }
  return undefined;
}

/**
 * Streams the transcript through grep/findstr in a child process, so the plugin only ever holds the
 * matching lines (a few records), never the file. Undefined when there is no record.
 * Throws on a read error; the caller logs it.
 */
export async function readSessionColor(host: Pick<ColorHost, 'process'>, path: string): Promise<AgentColorRecord | undefined> {
  const argv = onWindows() ? ['findstr', '/C:agent-color', path.replace(/\//g, '\\')] : ['grep', '-a', 'agent-color', path];
  const out = await host.process.run(argv, { timeoutMs: 20_000 });
  if (out.exitCode === 1) return undefined; // no match
  if (out.exitCode !== 0) throw new Error(`transcript scan exited ${out.exitCode}`);
  return newestColor(out.stdout ?? '');
}

export const MAX_COLOR_HOPS = 10;

const joinDir = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;

/** The session a given one was resumed from, out of current_session.json and log.jsonl. Undefined at the chain end. */
async function previousOf(host: Pick<ColorHost, 'fs'>, dir: string, id: string): Promise<string | undefined> {
  try {
    const p = joinDir(dir, 'current_session.json');
    if (await host.fs.exists(p)) {
      const cur = JSON.parse(await host.fs.read(p)) as { id?: unknown; previous_id?: unknown };
      if (cur.id === id && typeof cur.previous_id === 'string' && cur.previous_id && cur.previous_id !== id) return cur.previous_id;
    }
  } catch { /* fall through to log.jsonl */ }
  try {
    const p = joinDir(dir, 'log.jsonl');
    if (!(await host.fs.exists(p))) return undefined;
    const lines = (await host.fs.read(p)).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.startsWith('{')) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (r.event !== 'resumed' || r.session_id !== id) continue;
      if (typeof r.previous_id === 'string' && r.previous_id && r.previous_id !== id) return r.previous_id;
      // older rows have no previous_id; the resume file lives in the previous session's folder
      const m = typeof r.file === 'string' ? /([^\\/]+)[\\/][^\\/]+$/.exec(r.file) : null;
      if (m && m[1] !== id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(m[1]!)) return m[1];
      return undefined;
    }
  } catch { /* no chain info */ }
  return undefined;
}

export type ColorResult = { record?: AgentColorRecord; from?: string; scanned: number; errors: number };

/**
 * 0.5.13: the color of the cleared session. The session's own transcript wins; with no record there the
 * chain is walked back through previous ids (bounded), stopping at the newest transcript with a record.
 * Then the cache `<dir>/color.json`. A record found in a transcript refreshes the cache.
 */
export async function resolveColor(
  host: Pick<ColorHost, 'fs' | 'process'>, dir: string, sessionId: string,
  pathFor: (id: string) => Promise<string | undefined>, log: (text: string) => Promise<void>, maxHops = MAX_COLOR_HOPS,
): Promise<AgentColorRecord | undefined> {
  const res: ColorResult = { scanned: 0, errors: 0 };
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  for (let hop = 0; id && hop < maxHops && !seen.has(id); hop++) {
    seen.add(id);
    try {
      const path = await pathFor(id);
      if (path && (hop === 0 || await host.fs.exists(path))) {
        res.scanned++;
        const rec = await readSessionColor(host, path);
        if (rec) { res.record = rec; res.from = id; break; }
      }
    } catch { res.errors++; }
    id = await previousOf(host, dir, id);
  }
  if (res.record) {
    try {
      await host.fs.write(joinDir(dir, 'color.json'), JSON.stringify({ agentColor: res.record.agentColor, from_session: res.from, at: new Date().toISOString() }));
    } catch { /* the cache is a convenience */ }
    return res.record;
  }
  try {
    const p = joinDir(dir, 'color.json');
    if (await host.fs.exists(p)) {
      const c = JSON.parse(await host.fs.read(p)) as { agentColor?: unknown; from_session?: unknown };
      if (typeof c.agentColor === 'string' && c.agentColor) {
        await log(`handoff: no agent-color record in ${res.scanned} transcripts of the chain; using the cached color ${c.agentColor} (from ${String(c.from_session ?? '?').slice(0, 8)})`);
        return { type: 'agent-color', agentColor: c.agentColor };
      }
    }
  } catch { /* a bad cache is no cache */ }
  if (res.errors > 0) await log(`handoff: could not read the session color from the transcript (${res.errors} read errors, ${res.scanned} scanned); carrying on without it`);
  else await log(`handoff: no agent-color record in ${res.scanned} transcripts of the chain; carrying on without a color`);
  return undefined;
}

/**
 * Re-applies the color in the new session: `/color <name>` through `$.command.run` (the route the
 * clear uses). If the host lists no `color` command or the run fails, only a log line: the transcript is
 * never rewritten for a color.
 */
export async function carryColor(
  host: ColorHost, record: AgentColorRecord, newSessionId: string, newTranscript: string | undefined,
  log: (text: string) => Promise<void>,
): Promise<void> {
  try {
    let listed = false;
    try { listed = (await host.command.list()).some(c => c.name === 'color'); } catch { listed = false; }
    if (listed) {
      try {
        await host.command.run({ command: 'color', args: record.agentColor });
        await log(`handoff carried the session color (${record.agentColor}) with /color`);
        return;
      } catch { await log(`handoff: /color ${record.agentColor} failed after the clear; color not carried`); return; }
    }
    // No transcript write fallback (Ryan v2 review 2026-10-15): $.fs.write replaces the whole file, so a
    // failed read or a host append in between would destroy the new session's transcript. A lost color
    // is cheap; a lost transcript is not.
    void newSessionId; void newTranscript;
    await log(`handoff: no /color command listed by the host; color ${record.agentColor} not carried`);
  } catch {
    await log('handoff: color not carried; the handoff goes on');
  }
}
