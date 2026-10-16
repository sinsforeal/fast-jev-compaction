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

/**
 * Re-applies the color in the new session: `/color <name>` through `$.command.run` (the route the
 * clear uses). If the host lists no `color` command or the run fails, append an identical record to the
 * new transcript instead; that only takes effect at the next resume.
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
      } catch { await log('handoff: /color failed after the clear; falling back to a transcript record'); }
    }
    if (!newTranscript) { await log('handoff: color not carried (no transcript path for the new session)'); return; }
    const copy: AgentColorRecord = { ...record, sessionId: newSessionId };
    for (const key of ['uuid', 'timestamp'] as const) if (key in record) copy[key] = key === 'uuid' ? uuid4() : new Date().toISOString();
    let prior = '';
    try { if (await host.fs.exists(newTranscript)) prior = await host.fs.read(newTranscript); } catch { prior = ''; }
    if (prior && !prior.endsWith('\n')) prior += '\n';
    await host.fs.write(newTranscript, `${prior}${JSON.stringify(copy)}\n`);
    await log(`handoff wrote an agent-color record (${record.agentColor}) to the new transcript; it takes effect at the next resume`);
  } catch {
    await log('handoff: color not carried (write failed); the handoff goes on');
  }
}
