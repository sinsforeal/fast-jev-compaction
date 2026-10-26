/**
 * 0.5.17: console fallback for a refused handoff clear.
 *
 * Claude Code refuses a plugin's `$.command.run` after the session was stopped (Esc, interrupt) until a
 * person types into that session. A user who only talks through channels (voice, phone) never does, so the
 * retries of 0.5.16 cannot succeed (Pick Assist d1e9c530, 2026-10-26 12:08, attempts 1 and 2 refused).
 * The fallback types `/clear` + Enter into the session's own console, which is real input.
 *
 * Windows only. The plugin module is sandboxed (no node imports), so the console work is a PowerShell helper
 * with an Add-Type P/Invoke block, written next to the handoff files and started through `$.process.run`.
 * The helper is a child with its own handles: FreeConsole/AttachConsole there never touch the plugin's stdio.
 * Two runs: `read` finds the claude.exe pid that owns the session (~/.claude/sessions/<pid>.json) and returns
 * the visible rows; the verdict (`screenVerdict`) is judged here; `type` re-checks busy and prompt text once
 * more inside the helper (same rules) and then writes the key records. Never types into a busy session.
 */

/** The refusal Claude Code gives a plugin command after a stop: "the session was stopped and nobody has sent input since". */
export function isStoppedRefusal(text: unknown): boolean {
  const s = String((text as { message?: unknown } | undefined)?.message ?? text ?? '');
  return /session was (?:stopped|interrupted)|nobody has sent input|no(?:body| one) has (?:typed|sent) (?:any )?input/i.test(s);
}

export const onWindows = (): boolean => (globalThis as { process?: { platform?: string } }).process?.platform === 'win32';

export type ScreenVerdict = { ok: true } | { ok: false; reason: string };

/** Prompt marker (U+276F) and the box-drawing rule characters (U+2500, U+2501, U+2550), by code point. */
const PROMPT = String.fromCharCode(0x276F);
const RULE = new RegExp(`^[${String.fromCharCode(0x2500, 0x2501, 0x2550)}-]{8,}`);
const isRule = (row: string): boolean => RULE.test(row.trimStart());

/**
 * Idle with an empty prompt box, from the visible console rows (Claude Code 2.1.310 layout):
 *   rule row (may end with the session name) / `❯` or `>` prompt row / rule row / status line.
 * Busy shows `esc to interrupt` in the status line. A dialog has no prompt box. Typed text, a multi-line
 * input or a placeholder after the marker all count as not empty. The last prompt row on screen decides.
 */
export function screenVerdict(rows: readonly string[]): ScreenVerdict {
  const lines = rows.map(row => row.replace(/\s+$/, ''));
  if (lines.some(row => /esc to interrupt/i.test(row))) return { ok: false, reason: 'session is busy (esc to interrupt on screen)' };
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trimStart();
    if (t.startsWith(PROMPT) || t.startsWith('>')) { at = i; break; }
  }
  if (at < 0) return { ok: false, reason: 'no prompt box on screen' };
  if (at === 0 || !isRule(lines[at - 1]!)) return { ok: false, reason: 'prompt row has no rule above it' };
  if (at + 1 >= lines.length || !isRule(lines[at + 1]!)) return { ok: false, reason: 'prompt box is more than one row (text pending)' };
  const typed = lines[at]!.trimStart().slice(1).trim();
  if (typed.length > 0) return { ok: false, reason: 'prompt box is not empty' };
  return { ok: true };
}

export type ConsoleClearResult = { ok: true; pid: number } | { ok: false; error: string };

type ProcessHost = {
  fs: { write: (path: string, text: string) => Promise<void> };
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> };
};

export const CLEAR_TEXT = '/clear';

/** One JSON object per helper run, on its last stdout line. */
function parseHelper(stdout: string | undefined): Record<string, unknown> | undefined {
  const lines = String(stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]!) as Record<string, unknown>; } catch { /* try the line before */ }
  }
  return undefined;
}

const nativeJoin = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}\\${name}`.replace(/\//g, '\\');

/**
 * Types `/clear` + Enter into the console of the claude process that owns `sessionId`, only when the screen
 * says idle with an empty prompt box. Never throws; every failure comes back as `{ ok: false, error }`.
 */
export async function consoleClear(host: ProcessHost, input: { sessionId: string; dir: string }): Promise<ConsoleClearResult> {
  try {
    const script = nativeJoin(input.dir, 'console-clear.ps1');
    await host.fs.write(script, CONSOLE_HELPER_PS1);
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script];
    const seen = parseHelper((await host.process.run([...argv, 'read'], { timeoutMs: 30_000, env: { FJ_SID: input.sessionId } })).stdout);
    if (!seen) return { ok: false, error: 'console helper (read) returned nothing' };
    if (typeof seen.error === 'string') return { ok: false, error: `console read: ${seen.error.slice(0, 160)}` };
    const pid = Number(seen.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !Array.isArray(seen.rows)) return { ok: false, error: 'console helper (read) gave no pid or rows' };
    const verdict = screenVerdict(seen.rows.map(String));
    if (!verdict.ok) return { ok: false, error: `console not ready (pid ${pid}): ${verdict.reason}` };
    const sent = parseHelper((await host.process.run([...argv, 'type'], {
      timeoutMs: 30_000, env: { FJ_SID: input.sessionId, FJ_PID: String(pid), FJ_TEXT: CLEAR_TEXT },
    })).stdout);
    if (!sent) return { ok: false, error: `console helper (type) returned nothing (pid ${pid})` };
    if (typeof sent.error === 'string') return { ok: false, error: `console type (pid ${pid}): ${sent.error.slice(0, 160)}` };
    if (typeof sent.refused === 'string') return { ok: false, error: `console not ready (pid ${pid}): ${sent.refused.slice(0, 160)}` };
    const want = 2 * (CLEAR_TEXT.length + 1);
    if (Number(sent.typed) !== want) return { ok: false, error: `console typed ${String(sent.typed)} of ${want} key records (pid ${pid})` };
    return { ok: true, pid };
  } catch (error) {
    return { ok: false, error: `console fallback threw: ${String((error as { message?: unknown } | undefined)?.message ?? error).replace(/\s+/g, ' ').slice(0, 160)}` };
  }
}

/**
 * The helper script. ASCII only (the file is written through `$.fs.write`). Env in: FJ_SID, FJ_PID (type), FJ_TEXT (type).
 * Arg 1: read | type. Out: one JSON line. Rows are escaped to \uXXXX so the code page never matters.
 */
export const CONSOLE_HELPER_PS1 = String.raw`param([string]$Mode)
$ErrorActionPreference = 'Stop'
function Out-Err($m) { Write-Output ('{"error":' + (ConvertTo-Json -Compress ([string]$m)) + '}') }
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FjCon {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max; }
  [StructLayout(LayoutKind.Explicit, Size = 20)] struct REC {
    [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public int KeyDown; [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Vk; [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public ushort Ch; [FieldOffset(16)] public uint State; }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out INFO info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD at, out uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr h, REC[] recs, uint n, out uint written);
  static string Esc(string s) {
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\').Append(c); }
      else if (c < 0x20 || c > 0x7e) { b.Append("\\u").Append(((int)c).ToString("x4")); }
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static string Err(string what) { return "\"error\":" + Esc(what + ", code " + Marshal.GetLastWin32Error()); }
  static bool IsRule(string r) { r = r.TrimStart(); return r.Length >= 8 && (r[0] == (char)0x2500 || r[0] == (char)0x2501 || r[0] == (char)0x2550 || r[0] == '-'); }
  static string Guard(List<string> rows) {
    foreach (string r in rows) if (r.ToLowerInvariant().Contains("esc to interrupt")) return "session is busy (esc to interrupt on screen)";
    int at = -1;
    for (int i = rows.Count - 1; i >= 0; i--) { string t = rows[i].TrimStart(); if (t.Length > 0 && (t[0] == (char)0x276F || t[0] == '>')) { at = i; break; } }
    if (at < 0) return "no prompt box on screen";
    if (at == 0 || !IsRule(rows[at - 1])) return "prompt row has no rule above it";
    if (at + 1 >= rows.Count || !IsRule(rows[at + 1])) return "prompt box is more than one row (text pending)";
    if (rows[at].TrimStart().Substring(1).Trim().Length > 0) return "prompt box is not empty";
    return null;
  }
  public static string Run(uint pid, string mode, string text) {
    FreeConsole();
    if (!AttachConsole(pid)) return Err("AttachConsole(" + pid + ") failed");
    try {
      IntPtr bad = new IntPtr(-1);
      IntPtr hout = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (hout == bad) return Err("CONOUT$ open failed");
      List<string> rows = new List<string>();
      try {
        INFO info;
        if (!GetConsoleScreenBufferInfo(hout, out info)) return Err("GetConsoleScreenBufferInfo failed");
        int width = info.Window.Right - info.Window.Left + 1;
        for (int y = info.Window.Top; y <= info.Window.Bottom; y++) {
          StringBuilder sb = new StringBuilder(width + 1);
          uint n;
          COORD at = new COORD(); at.X = info.Window.Left; at.Y = (short)y;
          if (!ReadConsoleOutputCharacterW(hout, sb, (uint)width, at, out n)) return Err("ReadConsoleOutputCharacterW failed");
          rows.Add(sb.ToString(0, (int)Math.Min(n, (uint)sb.Length)).TrimEnd());
        }
      } finally { CloseHandle(hout); }
      if (mode == "read") {
        List<string> parts = new List<string>();
        foreach (string r in rows) parts.Add(Esc(r));
        return "\"rows\":[" + string.Join(",", parts.ToArray()) + "]";
      }
      string why = Guard(rows);
      if (why != null) return "\"refused\":" + Esc(why);
      IntPtr hin = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (hin == bad) return Err("CONIN$ open failed");
      try {
        string all = text + "\r";
        REC[] recs = new REC[all.Length * 2];
        for (int i = 0; i < all.Length; i++) {
          for (int d = 0; d < 2; d++) {
            REC r = new REC(); r.EventType = 1; r.KeyDown = d == 0 ? 1 : 0; r.Repeat = 1;
            r.Vk = (ushort)(all[i] == '\r' ? 0x0D : 0); r.Scan = (ushort)(all[i] == '\r' ? 0x1C : 0); r.Ch = all[i];
            recs[i * 2 + d] = r;
          }
        }
        uint written;
        if (!WriteConsoleInputW(hin, recs, (uint)recs.Length, out written)) return Err("WriteConsoleInputW failed");
        return "\"typed\":" + written;
      } finally { CloseHandle(hin); }
    } finally { FreeConsole(); }
  }
}
'@
  $sid = [string]$env:FJ_SID
  if ($Mode -eq 'read') {
    $best = $null
    $dir = Join-Path $env:USERPROFILE '.claude\sessions'
    foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter '*.json')) {
      try { $d = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
      if ($d.sessionId -ne $sid -or -not $d.pid) { continue }
      if (-not (Get-Process -Id ([int]$d.pid) -ErrorAction SilentlyContinue)) { continue }
      if ($best -eq $null -or [long]$d.updatedAt -gt [long]$best.updatedAt) { $best = $d }
    }
    if ($best -eq $null) { Out-Err ('no live claude process owns session ' + $sid); exit 0 }
    $target = [uint32][int]$best.pid
  } else {
    $target = [uint32][int]$env:FJ_PID
  }
  $out = [FjCon]::Run($target, $Mode, [string]$env:FJ_TEXT)
  Write-Output ('{"pid":' + $target + ',' + $out + '}')
} catch { Out-Err $_.Exception.Message }
`;
