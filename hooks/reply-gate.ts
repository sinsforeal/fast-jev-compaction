/**
 * 0.5.25: a reply to the User stays visible at least `replyVisibleMinMs` (default 10 min) before the
 * handoff clear. Only a reply to the User's own message counts. Replies to peer messages, plugin prompts
 * (HANDOFF NOW / RESUME) and hook feedback do not. 0.5.30: a reply in a turn a task notification started
 * counts too, when his own last message is at most NOTIFICATION_WINDOW_MS (60 min) before the notification:
 * the report of the result of his own order, made when the agent he caused finished, answers him.
 *
 * The session transcript is the evidence (the plugin cannot see every delivery): this module reads the
 * tail of `<home>/.claude/projects/<slug>/<sid>.jsonl`, keeps only the user records that start or
 * continue a turn, the assistant text records and the turn_duration markers, and works out from them
 *   - the time of the last reply to the User (or of his message, when it has no reply yet),
 *   - whether a turn is running (a turn opens with a user record and ends with a turn_duration marker,
 *     or a "[Request interrupted" record),
 *   - the time of the newest prompt of any kind (to tell a stale handoff file after a wait).
 *
 * How the jsonl marks a turn (Claude Code 2.1.3xx, read from real transcripts 2026-11-16):
 *   his message      type user, origin {"kind":"human"}, promptSource typed or queued
 *   feed / headset   type user, isMeta true, origin {"kind":"channel","server":"feed"|"pick-assist"}
 *                    (never seen in a transcript on disk yet; same rule as standing.ts isUserPrompt)
 *   peer message     type user, isMeta true, origin {"kind":"channel","server":"peer"}
 *   task notification type user, origin {"kind":"task-notification",...}
 *   plugin prompt    type user, origin {"kind":"plugin","name":"fast-jev-compaction"}
 *   stop-hook feedback / reminder / image companion: type user, isMeta true, no origin key
 *   interrupt        type user, no origin, text "[Request interrupted by user]"
 *   turn end         type system, subtype turn_duration
 *
 * Nothing here throws. Anything unreadable comes back as `{ ok: false }`; since 0.5.26 the caller then holds
 * the clear for the full minimum from the time it was asked (fails closed), where 0.5.25 let it go at once.
 */

import { onWindows } from './console-clear.js';

/** One kept transcript record. r: u user prompt, a assistant text, e turn end. t: epoch ms. */
export type Slim = {
  r: 'u' | 'a' | 'e';
  t: number;
  side?: boolean;
  meta?: boolean;
  origin?: { kind?: string; server?: string } | null;
  /** First characters of the text of a user record, still JSON-escaped. */
  head?: string;
};

export type TailRead = { ok: true; records: Slim[] } | { ok: false; error: string };

/** Tail window read from the transcript. The newest turns are at the end; 24 MB covers hours of work. */
export const TAIL_BYTES = 24_000_000;

const HEAD_STRING = /"role":"user","content":(?:"((?:[^"\\]|\\.){0,120})|\[\{"type":"text","text":"((?:[^"\\]|\\.){0,120}))/;
const ORIGIN = /"origin":(\{[^{}]*\})/;
const STAMP = /"timestamp":"([^"]+)"/;

/**
 * One raw transcript line to a kept record, or undefined. Substring and regex work only: a line can be
 * megabytes (tool results), so it is never JSON-parsed here. The check order matches the PowerShell helper.
 */
export function slimLine(raw: string): Slim | undefined {
  let r: Slim['r'];
  if (raw.includes('"type":"system"')) {
    if (!raw.includes('"subtype":"turn_duration"')) return undefined;
    r = 'e';
  } else if (raw.includes('"type":"user"')) {
    if (raw.includes('"type":"tool_result"')) return undefined;
    r = 'u';
  } else if (raw.includes('"type":"assistant"')) {
    if (!raw.includes('"type":"text"')) return undefined;
    r = 'a';
  } else return undefined;
  const stamp = STAMP.exec(raw)?.[1];
  const t = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const out: Slim = { r, t };
  if (raw.includes('"isSidechain":true')) out.side = true;
  if (r === 'u') {
    if (raw.includes('"isMeta":true')) out.meta = true;
    const origin = ORIGIN.exec(raw)?.[1];
    if (origin) { try { out.origin = JSON.parse(origin) as Slim['origin']; } catch { /* no origin */ } }
    const head = HEAD_STRING.exec(raw);
    const text = head?.[1] ?? head?.[2];
    if (text !== undefined) out.head = text;
  }
  return out;
}

/** Output of the tail helper: one JSON object per kept record (PowerShell route) or raw lines (grep route). */
export function parseTail(stdout: string | undefined): Slim[] {
  const out: Slim[] = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let rec: Slim | undefined;
    if (text.startsWith('{"r":"')) {
      try {
        const p = JSON.parse(text) as { r?: unknown; t?: unknown; side?: unknown; meta?: unknown; origin?: unknown; head?: unknown };
        const t = typeof p.t === 'string' ? Date.parse(p.t) : NaN;
        if ((p.r === 'u' || p.r === 'a' || p.r === 'e') && Number.isFinite(t)) {
          rec = { r: p.r, t };
          if (p.side === 1 || p.side === true) rec.side = true;
          if (p.meta === 1 || p.meta === true) rec.meta = true;
          if (p.origin && typeof p.origin === 'object') rec.origin = p.origin as Slim['origin'];
          if (typeof p.head === 'string') rec.head = p.head;
        }
      } catch { /* a damaged line is skipped */ }
    } else rec = slimLine(text);
    if (rec) out.push(rec);
  }
  return out;
}

const FEED_WRAP = /^\s*<channel\s+source="(?:feed|pick-assist)"/i;
const RESTART_PROMPT = /^\s*Window restarted by Ryan v2\b/;
const COMPANION_HEAD = /^\s*(?:<local-command|<command-name|<system-reminder|<task-notification|Stop hook feedback|\[Image)/;

export type UserKind = 'his' | 'notification' | 'other' | 'companion' | 'interrupt';

/**
 * 0.5.30: a turn that a task notification starts counts as a turn of his when his own last message is at most
 * this long before the notification. Case: meta session ac9a295b, 2026-11-19. His order at 09:27:54Z, the
 * build agent for it finished at 09:39:28Z (a task-notification record starts a turn), the landing report was
 * the reply at 09:41:41Z, and the clear went at 09:43:02Z with no hold because the gate anchored on the 09:31:00Z
 * reply to the order itself. The report of an agent he caused answers him.
 */
export const NOTIFICATION_WINDOW_MS = 60 * 60_000;

/**
 * His own message: origin human (typed or queued), or a channel message from feed / pick-assist (his phone
 * or headset); composer and bridge too, the kinds standing.ts counts. A task notification (origin kind
 * `task-notification`, a record that has an origin key in Claude Code 2.1.327) is `notification`: it starts a
 * turn that analyzeTail counts as his only when his own last message is within NOTIFICATION_WINDOW_MS. A peer
 * channel message, plugin prompt, the restart prompt or any other origin is `other` and never counts.
 * Stop-hook feedback, a system-reminder companion, an image note, the /clear command records and a record with
 * no origin key whose text starts `<task-notification` (older transcripts; not the 11-19 case) are
 * `companion`: they continue the turn they sit in and never start one. `[Request interrupted` ends the turn.
 */
export function classifyUser(rec: Slim): UserKind {
  const head = rec.head ?? '';
  if (/^\s*(?:<local-command|<command-name)/.test(head)) return 'companion';
  if (RESTART_PROMPT.test(head)) return 'other';
  const kind = rec.origin?.kind;
  if (kind === 'human' || kind === 'composer' || kind === 'bridge') return 'his';
  if (kind === 'task-notification') return 'notification';
  if (kind === 'channel') return /^(feed|pick-assist)$/i.test(String(rec.origin?.server ?? '')) || FEED_WRAP.test(head) ? 'his' : 'other';
  if (kind === 'unclassified') return FEED_WRAP.test(head) ? 'his' : 'other';
  if (kind !== undefined) return 'other';
  // No origin key.
  if (head.startsWith('[Request interrupted')) return 'interrupt';
  if (rec.meta || COMPANION_HEAD.test(head)) return 'companion';
  return 'his'; // an older transcript: a plain, non-meta user prompt is a person
}

export type TailView = {
  /**
   * Time of the last assistant text in a turn that counts as his: the newest turn his message started, or a
   * later task-notification turn within NOTIFICATION_WINDOW_MS of that message (0.5.30).
   */
  replyAt?: number;
  /**
   * replyAt, or the time of his message when no counting turn has a reply yet. A notification turn with no
   * assistant text moves nothing. Undefined = no turn of his in the window.
   */
  anchorAt?: number;
  /** A turn is open: its user record has no turn end after it. */
  busy: boolean;
  /** Time of the newest prompt of any origin (companions excluded). */
  lastPromptAt?: number;
  /** Records looked at. */
  count: number;
};

/**
 * Walks the kept records and finds the reply the gate anchors on. A turn opens at each prompt record that is
 * not a companion. An assistant text moves the anchor only when its turn counts:
 *   - a turn his own message started (origin human, feed, pick-assist, composer, bridge): always;
 *   - 0.5.30: a turn a task notification started, when his own last message (the start of the newest turn of
 *     his) is at most NOTIFICATION_WINDOW_MS before the notification. Its text is stored on his turn, so
 *     replyAt and anchorAt move as for a reply in his own turn. A notification turn with no assistant text
 *     moves nothing: the anchor does not go to the notification's start time;
 *   - a turn started by a peer channel message, plugin prompt, restart prompt or any other origin: never,
 *     whatever its age.
 * `busy` and `lastPromptAt` follow every non-companion prompt of any origin.
 */
export function analyzeTail(records: readonly Slim[]): TailView {
  type Turn = { startedAt: number; replyAt?: number };
  let cur: { counts: Turn | undefined } | undefined;
  let lastHis: Turn | undefined;
  let busy = false;
  let lastPromptAt: number | undefined;
  for (const rec of records) {
    if (rec.side) continue;
    if (rec.r === 'e') { busy = false; continue; }
    if (rec.r === 'a') { if (cur?.counts) cur.counts.replyAt = rec.t; continue; }
    const kind = classifyUser(rec);
    if (kind === 'companion') continue;
    if (kind === 'interrupt') { busy = false; continue; }
    if (kind === 'his') {
      lastHis = { startedAt: rec.t };
      cur = { counts: lastHis };
    } else if (kind === 'notification' && lastHis && rec.t >= lastHis.startedAt && rec.t - lastHis.startedAt <= NOTIFICATION_WINDOW_MS) {
      cur = { counts: lastHis };
    } else cur = { counts: undefined };
    busy = true;
    lastPromptAt = rec.t;
  }
  const view: TailView = { busy, count: records.length };
  if (lastHis) { view.anchorAt = lastHis.replyAt ?? lastHis.startedAt; if (lastHis.replyAt !== undefined) view.replyAt = lastHis.replyAt; }
  if (lastPromptAt !== undefined) view.lastPromptAt = lastPromptAt;
  return view;
}

/**
 * Milliseconds the clear still has to wait: 0 when the gate is off, no turn of his is in the view, or the reply
 * is old enough. The age of his own message never shortens it: a reply that ends a long turn he started is held
 * like any other.
 */
export function gateWait(view: TailView, now: number, minMs: number): number {
  if (!(minMs > 0) || view.anchorAt === undefined) return 0;
  const age = Math.max(0, now - view.anchorAt);
  return age >= minMs ? 0 : minMs - age;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** HH:MM:SS in the machine's local time. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type TailHost = {
  /** `read` and `stat` are the host's own file API (0.5.26 reads the transcript with them); both optional so older stand-ins still fit. */
  fs: {
    write: (path: string, text: string) => Promise<void>;
    read?: (path: string) => Promise<string>;
    stat?: (path: string) => Promise<{ kind: string; size: number; mtimeMs: number }>;
  };
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout?: string }> };
};

const nativeJoin = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}\\${name}`.replace(/\//g, '\\');

/** The part of node:fs the tail read uses. */
export type NodeFsLike = {
  openSync: (path: string, flags: string) => number;
  fstatSync: (fd: number) => { size: number };
  readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
};

/** node:fs through `process.getBuiltinModule` (the plugin has no import of node modules); undefined when the host has none. */
export function hostNodeFs(): NodeFsLike | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.('node:fs') as Partial<NodeFsLike> | undefined;
    return fs && typeof fs.openSync === 'function' && typeof fs.readSync === 'function' && typeof fs.fstatSync === 'function' && typeof fs.closeSync === 'function'
      ? fs as NodeFsLike : undefined;
  } catch { return undefined; }
}

/**
 * Plain read of the last `bytes` of the transcript with node:fs: no child process, no window. Splits on LF,
 * drops the first line when the read starts inside the file (a cut line), and keeps the slim records.
 * Throws on a missing or unreadable file; readTail catches.
 */
export function readTailNode(fs: NodeFsLike, path: string, bytes: number = TAIL_BYTES): Slim[] {
  const fd = fs.openSync(path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const r = fs.readSync(fd, buf, got, n - got, size - n + got);
      if (r <= 0) break;
      got += r;
    }
    const lines = new TextDecoder('utf-8').decode(buf.subarray(0, got)).split('\n');
    const out: Slim[] = [];
    for (let i = n < size ? 1 : 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length < 20) continue;
      const rec = slimLine(line);
      if (rec) out.push(rec);
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** Whole-file reads through the host are refused above this size (the string would be held in the plugin). */
export const HOST_READ_MAX_BYTES = 256_000_000;

/**
 * 0.5.26: reads the tail through the host's own `$.fs` (stat, then read), no child process and no shell. The
 * host hands back the whole file as a string; the last `bytes` characters are kept and the first, cut line is
 * dropped. Throws when the host has no read, the file is too big or the read fails; readTail catches.
 */
export async function readTailHostFs(host: TailHost, path: string, bytes: number = TAIL_BYTES): Promise<Slim[]> {
  // The hooks loader refuses a module that reads an event of `$` as a value (0.5.27: `if (host.fs.read)` did
  // not load), and `host` here is `$`. So no existence test: call, and let a host without it throw.
  let size = -1;
  try { size = (await host.fs.stat!(path)).size; } catch { /* no stat on this host: the read decides */ }
  if (size > HOST_READ_MAX_BYTES) throw new Error(`transcript is ${size} bytes, over the ${HOST_READ_MAX_BYTES} host read cap`);
  const all = await host.fs.read!(path);
  const cut = all.length > bytes;
  const lines = (cut ? all.slice(all.length - bytes) : all).split('\n');
  const out: Slim[] = [];
  for (let i = cut ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 20) continue;
    const rec = slimLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
const msg = (error: unknown): string => String((error as { message?: unknown } | undefined)?.message ?? error).replace(/\s+/g, ' ').slice(0, 120);

/**
 * Reads the transcript tail, first route that works wins:
 *   1. node:fs inside the plugin process (`nodeFs`, default the host's own, or null to skip);
 *   2. 0.5.26: the host's own `$.fs.read` (no shell; this is the route that works where `process` is not visible);
 *   3. a child process, so the plugin only holds the kept records. A Windows path (drive letter) or a
 *      win32 process: a hidden PowerShell helper written next to the handoff files. Elsewhere: tail + grep.
 * 0.5.25 tried 1 and 3 only and chose `sh` on a Windows host whose plugin sandbox hides `process.platform`
 * (log 2026-11-18T22:03:21Z, session 198c03d3): the read failed and the gate let the clear go. Never throws.
 */
export async function readTail(host: TailHost, input: { path: string; dir: string }, nodeFs: NodeFsLike | null | undefined = hostNodeFs()): Promise<TailRead> {
  const errors: string[] = [];
  if (nodeFs) {
    try { return { ok: true, records: readTailNode(nodeFs, input.path) }; } catch (error) { errors.push(`node:fs ${msg(error)}`); }
  } else errors.push('no node:fs');
  try { return { ok: true, records: await readTailHostFs(host, input.path) }; } catch (error) { errors.push(`$.fs ${msg(error)}`); }
  const windows = onWindows() || WINDOWS_PATH.test(input.path);
  try {
    const env = { FJ_PATH: windows ? input.path.replace(/\//g, '\\') : input.path, FJ_TAIL: String(TAIL_BYTES) };
    let argv: string[];
    if (windows) {
      const script = nativeJoin(input.dir, 'reply-tail.ps1');
      await host.fs.write(script, TAIL_HELPER_PS1);
      argv = ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script];
    } else {
      argv = ['sh', '-c', `tail -c "$FJ_TAIL" "$FJ_PATH" | grep -a -E '"type":"(user|assistant|system)"' | grep -a -v '"type":"tool_result"' | grep -a -E '"type":"user"|"type":"text"|"subtype":"turn_duration"'`];
    }
    const out = await host.process.run(argv, { timeoutMs: 60_000, env });
    if (out.exitCode === 1 && !windows) return { ok: true, records: [] }; // grep: no match
    if (out.exitCode !== 0) return { ok: false, error: `${errors.join('; ')}; tail helper exited ${out.exitCode}`.slice(0, 300) };
    return { ok: true, records: parseTail(out.stdout) };
  } catch (error) {
    return { ok: false, error: `${errors.join('; ')}; helper ${msg(error)}`.slice(0, 300) };
  }
}

/**
 * The PowerShell helper. ASCII only. Env in: FJ_PATH (transcript), FJ_TAIL (bytes). Out: one JSON line per
 * kept record, {"r","t","side","meta","origin","head"}; same checks and regexes as slimLine. Opens the file
 * with FileShare ReadWrite (Claude Code is appending to it).
 */
export const TAIL_HELPER_PS1 = String.raw`$ErrorActionPreference = 'Stop'
try {
  $p = [string]$env:FJ_PATH
  $want = [long]$env:FJ_TAIL
  $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
  try {
    $len = $fs.Length
    $n = [Math]::Min($len, $want)
    [void]$fs.Seek($len - $n, 'Begin')
    $buf = New-Object byte[] ([int]$n)
    $got = 0
    while ($got -lt $n) { $r = $fs.Read($buf, $got, [int]($n - $got)); if ($r -le 0) { break }; $got += $r }
  } finally { $fs.Dispose() }
  $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $got)
  $nl = [string][char]10
  $lines = $text.Split([char]10)
  $first = 0
  if ($n -lt $len) { $first = 1 }
  $reStamp = New-Object System.Text.RegularExpressions.Regex('"timestamp":"([^"]+)"')
  $reOrigin = New-Object System.Text.RegularExpressions.Regex('"origin":(\{[^{}]*\})')
  $reHead = New-Object System.Text.RegularExpressions.Regex('"role":"user","content":(?:"((?:[^"\\]|\\.){0,120})|\[\{"type":"text","text":"((?:[^"\\]|\\.){0,120}))')
  $sb = New-Object System.Text.StringBuilder
  for ($i = $first; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    if ($line.Length -lt 20) { continue }
    $k = $null
    if ($line.Contains('"type":"system"')) { if ($line.Contains('"subtype":"turn_duration"')) { $k = 'e' } }
    elseif ($line.Contains('"type":"user"')) { if (-not $line.Contains('"type":"tool_result"')) { $k = 'u' } }
    elseif ($line.Contains('"type":"assistant"')) { if ($line.Contains('"type":"text"')) { $k = 'a' } }
    if ($k -eq $null) { continue }
    $m = $reStamp.Match($line)
    if (-not $m.Success) { continue }
    $o = '{"r":"' + $k + '","t":"' + $m.Groups[1].Value + '"'
    if ($line.Contains('"isSidechain":true')) { $o += ',"side":1' }
    if ($k -eq 'u') {
      if ($line.Contains('"isMeta":true')) { $o += ',"meta":1' }
      $mo = $reOrigin.Match($line)
      if ($mo.Success) { $o += ',"origin":' + $mo.Groups[1].Value }
      $mh = $reHead.Match($line)
      if ($mh.Success) {
        $h = $mh.Groups[1].Value
        if (-not $mh.Groups[1].Success) { $h = $mh.Groups[2].Value }
        $h = [regex]::Replace($h, '[^\x20-\x7e]', '?')
        $o += ',"head":' + (ConvertTo-Json -Compress -InputObject ([string]$h))
      }
    }
    [void]$sb.Append($o + '}' + $nl)
  }
  [Console]::Out.Write($sb.ToString())
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
`;
