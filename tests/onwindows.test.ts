import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearOrderMarker, deleteArgv, moveArgv, writeOrderMarker, type HandoffHost } from '../hooks/handoff.ts';
import { colorFromText, JS_READ_MAX_BYTES, readSessionColor, scanArgv } from '../hooks/color-carry.ts';
import { consoleClear, NOT_WINDOWS } from '../hooks/console-clear.ts';
import { detectWindows, isWindowsPath, nativeWindowsPath, platformSource } from '../hooks/platform.ts';

// 0.5.31: process.platform is not visible in the plugin host, so the old per-file onWindows() was false on the
// Windows PC. These tests take process.platform away (the host's view) and check both branches of every caller.
const realPlatform = platformSource.processPlatform;
const hostView = (platform: string | undefined) => { platformSource.processPlatform = () => platform; };
afterEach(() => { platformSource.processPlatform = realPlatform; });

const WIN_ENV = { get: async (name: string) => (name === 'OS' ? 'Windows_NT' : undefined) };
const POSIX_ENV = { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) };

describe('detectWindows', () => {
  it.each([
    ['process.platform win32', 'win32', undefined, [], true],
    ['host shim that says linux but a drive-letter path', 'linux', undefined, ['F:/h/s/order.json'], true],
    ['no process, backslash drive path', undefined, undefined, ['C:\\Users\\x'], true],
    ['no process, UNC path', undefined, undefined, ['\\\\srv\\share\\h'], true],
    ['no process, posix paths, OS=Windows_NT', undefined, WIN_ENV, ['/tmp/h'], true],
    ['no process, posix paths, posix env', undefined, POSIX_ENV, ['/tmp/h'], false],
    ['no process, no env, no paths', undefined, undefined, [], false],
    ['no process, relative path only', undefined, undefined, ['var/handoffs'], false],
  ] as const)('%s', async (_name, platform, env, hints, expected) => {
    hostView(platform);
    expect(await detectWindows(env ? { env } : undefined, hints)).toBe(expected);
  });

  it('SystemRoot with a drive letter counts when OS is gone', async () => {
    hostView(undefined);
    expect(await detectWindows({ env: { get: async (n: string) => (n === 'SystemRoot' ? 'C:\\Windows' : undefined) } }, [])).toBe(true);
  });

  it('an env that throws is no signal and never throws', async () => {
    hostView(undefined);
    expect(await detectWindows({ env: { get: async () => { throw new Error('refused'); } } }, ['/x'])).toBe(false);
  });

  it('path helpers', () => {
    expect(isWindowsPath('F:/a')).toBe(true);
    expect(isWindowsPath('/a')).toBe(false);
    expect(isWindowsPath('F:')).toBe(false);
    expect(nativeWindowsPath('F:/a/b')).toBe('F:\\a\\b');
  });
});

// ---- handoff.ts: order marker move and delete ----

function markerHost(env: { get: (n: string) => Promise<string | undefined> } | undefined) {
  const files = new Map<string, string>();
  const argvs: string[][] = [];
  const host = {
    ...(env ? { env } : {}),
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => files.get(p)!,
      write: async (p: string, t: string) => { files.set(p, t); },
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    },
    process: { run: vi.fn(async (argv: readonly string[]) => { argvs.push([...argv]); return { exitCode: 0 }; }) },
  };
  return { host: host as unknown as HandoffHost, files, argvs };
}
const marker = { order: 'now' as const, tokens: 1, limit: 2, attempt: 1 };

describe('handoff.ts marker commands per platform', () => {
  it('Windows as the host shows it (no process.platform, OS=Windows_NT, posix dir): cmd move and cmd del, never mv or rm', async () => {
    hostView(undefined);
    const h = markerHost(WIN_ENV);
    const path = await writeOrderMarker(h.host, '/var/handoffs', 's1', marker);
    h.files.set(path, '{}');
    await clearOrderMarker(h.host, '/var/handoffs', 's1');
    expect(h.argvs.map(a => a[0])).toEqual(['cmd', 'cmd']);
    expect(h.argvs[0]!.slice(1, 4)).toEqual(['/c', 'move', '/Y']);
    expect(h.argvs[1]!.slice(1, 4)).toEqual(['/c', 'del', '/F']);
    expect(h.argvs.flat()).not.toContain('rm');
    expect(h.argvs.flat()).not.toContain('mv');
  });

  it('Windows by drive-letter dir alone (no env at all)', async () => {
    hostView(undefined);
    const h = markerHost(undefined);
    const path = await writeOrderMarker(h.host, 'F:/h', 's1', marker);
    h.files.set(path, '{}');
    await clearOrderMarker(h.host, 'F:/h', 's1');
    expect(h.argvs[0]).toEqual(['cmd', '/c', 'move', '/Y', 'F:\\h\\s1\\order.json.tmp', 'F:\\h\\s1\\order.json']);
    expect(h.argvs[1]).toEqual(['cmd', '/c', 'del', '/F', '/Q', 'F:\\h\\s1\\order.json']);
  });

  it('non-Windows: mv -f and rm -f, forward slashes kept', async () => {
    hostView('linux');
    const h = markerHost(POSIX_ENV);
    const path = await writeOrderMarker(h.host, '/var/handoffs', 's1', marker);
    h.files.set(path, '{}');
    await clearOrderMarker(h.host, '/var/handoffs', 's1');
    expect(h.argvs[0]).toEqual(['mv', '-f', '/var/handoffs/s1/order.json.tmp', '/var/handoffs/s1/order.json']);
    expect(h.argvs[1]).toEqual(['rm', '-f', '/var/handoffs/s1/order.json']);
  });

  it('a failing delete still rewrites the marker as order none', async () => {
    hostView(undefined);
    const h = markerHost(WIN_ENV);
    h.host.process.run = vi.fn(async () => ({ exitCode: 1 }));
    const path = await writeOrderMarker(h.host, '/var/handoffs', 's1', marker);
    h.files.set(path, '{}');
    const logs: string[] = [];
    await clearOrderMarker(h.host, '/var/handoffs', 's1', async t => { logs.push(t); });
    expect(JSON.parse(h.files.get(path)!).order).toBe('none');
    expect(logs[0]).toContain('could not delete');
  });

  it('argv builders', () => {
    expect(moveArgv(true, 'a/b', 'a/c')).toEqual(['cmd', '/c', 'move', '/Y', 'a\\b', 'a\\c']);
    expect(moveArgv(false, 'a/b', 'a/c')).toEqual(['mv', '-f', 'a/b', 'a/c']);
    expect(deleteArgv(true, 'a/b')).toEqual(['cmd', '/c', 'del', '/F', '/Q', 'a\\b']);
    expect(deleteArgv(false, 'a/b')).toEqual(['rm', '-f', 'a/b']);
  });

  // The real commands, on a real Windows machine: the argv the plugin builds must do the job.
  it.runIf(process.platform === 'win32')('REAL cmd move and cmd del on disk', () => {
    const dir = join('F:/temp', `jevwin-onwindows-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'order.json.tmp');
    const to = join(dir, 'order.json');
    writeFileSync(tmp, 'new'); writeFileSync(to, 'old');
    const run = (argv: string[]) => spawnSync(argv[0]!, argv.slice(1), { windowsHide: true });
    expect(run(moveArgv(true, tmp.replace(/\\/g, '/'), to.replace(/\\/g, '/'))).status).toBe(0);
    expect(existsSync(tmp)).toBe(false);
    expect(readFileSync(to, 'utf8')).toBe('new');
    expect(run(deleteArgv(true, to.replace(/\\/g, '/'))).status).toBe(0);
    expect(existsSync(to)).toBe(false);
  });
});

// ---- color-carry.ts: reading the session color ----

const rec = (color: string) => JSON.stringify({ type: 'agent-color', agentColor: color, sessionId: 's' });

function colorHost(opts: { size?: number; text?: string; statFails?: boolean; env?: typeof WIN_ENV; scan?: { exitCode: number; stdout?: string } }) {
  return {
    ...(opts.env ? { env: opts.env } : {}),
    fs: {
      stat: vi.fn(async () => { if (opts.statFails) throw new Error('ENOENT'); return { kind: 'file', size: opts.size ?? (opts.text ?? '').length, mtimeMs: 0 }; }),
      read: vi.fn(async () => opts.text ?? ''),
    },
    process: { run: vi.fn(async () => opts.scan ?? { exitCode: 1, stdout: '' }) },
  } as unknown as Parameters<typeof readSessionColor>[0] & { fs: { read: ReturnType<typeof vi.fn> }; process: { run: ReturnType<typeof vi.fn> } };
}

describe('color-carry.ts without grep', () => {
  it('a transcript the host can read is scanned in JS: newest record, no child process, on either platform', async () => {
    const text = [rec('blue'), '{"type":"user","text":"agent-color noise"}', rec('red'), '{"type":"user"}'].join('\n');
    for (const view of [undefined, 'linux'] as const) {
      hostView(view);
      const host = colorHost({ text, env: WIN_ENV });
      expect((await readSessionColor(host, 'C:/t/s.jsonl'))?.agentColor).toBe('red');
      expect(host.process.run).not.toHaveBeenCalled();
    }
    expect(colorFromText('no record here\n')).toBeUndefined();
  });

  it('no record in a readable transcript is undefined, not an error', async () => {
    hostView(undefined);
    const host = colorHost({ text: '{"type":"user"}\n' });
    expect(await readSessionColor(host, 'C:/t/s.jsonl')).toBeUndefined();
  });

  it('a transcript over the read limit goes to findstr on Windows (host shows no process.platform): backslash path, never grep', async () => {
    hostView(undefined);
    const host = colorHost({ size: JS_READ_MAX_BYTES + 1, env: WIN_ENV, scan: { exitCode: 0, stdout: `${rec('green')}\n` } });
    expect((await readSessionColor(host, 'C:/Users/x/.claude/projects/p/s.jsonl'))?.agentColor).toBe('green');
    expect(host.fs.read).not.toHaveBeenCalled();
    expect(host.process.run.mock.calls[0]![0]).toEqual(['findstr', '/C:agent-color', 'C:\\Users\\x\\.claude\\projects\\p\\s.jsonl']);
  });

  it('a big transcript on a non-Windows host goes to grep -a', async () => {
    hostView('linux');
    const host = colorHost({ size: JS_READ_MAX_BYTES + 1, env: POSIX_ENV, scan: { exitCode: 0, stdout: `${rec('pink')}\n` } });
    expect((await readSessionColor(host, '/home/u/.claude/projects/p/s.jsonl'))?.agentColor).toBe('pink');
    expect(host.process.run.mock.calls[0]![0]).toEqual(['grep', '-a', 'agent-color', '/home/u/.claude/projects/p/s.jsonl']);
  });

  it('a failing stat or a failing read falls back to the child process; its exit codes keep their meaning', async () => {
    hostView(undefined);
    const noStat = colorHost({ statFails: true, env: WIN_ENV, scan: { exitCode: 1 } });
    expect(await readSessionColor(noStat, 'C:/t/s.jsonl')).toBeUndefined();
    expect(noStat.process.run).toHaveBeenCalledTimes(1);
    const badRead = colorHost({ text: 'x', env: WIN_ENV, scan: { exitCode: 2 } });
    badRead.fs!.read = vi.fn(async () => { throw new Error('EACCES'); });
    await expect(readSessionColor(badRead, 'C:/t/s.jsonl')).rejects.toThrow('transcript scan exited 2');
  });

  it('scanArgv per platform', () => {
    expect(scanArgv(true, 'F:/a/b.jsonl')).toEqual(['findstr', '/C:agent-color', 'F:\\a\\b.jsonl']);
    expect(scanArgv(false, '/a/b.jsonl')).toEqual(['grep', '-a', 'agent-color', '/a/b.jsonl']);
  });

  // The real findstr on a real transcript-shaped file over the read limit, with a megabyte-long line in it.
  it.runIf(process.platform === 'win32')('REAL findstr on a 5 MB file with a very long line', async () => {
    hostView(undefined);
    const dir = join('F:/temp', `jevwin-onwindows-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 's.jsonl').replace(/\\/g, '/');
    const long = JSON.stringify({ type: 'user', text: 'y'.repeat(1_000_000) });
    writeFileSync(path, [rec('blue'), long, long, long, long, rec('orange'), long, long].join('\n') + '\n');
    const host = {
      env: WIN_ENV,
      fs: { stat: async (p: string) => ({ kind: 'file', size: readFileSync(p).length, mtimeMs: 0 }), read: async () => { throw new Error('over the limit'); } },
      process: { run: async (argv: readonly string[]) => { const r = spawnSync(argv[0]!, argv.slice(1), { windowsHide: true, maxBuffer: 64 << 20 }); return { exitCode: r.status ?? -1, stdout: String(r.stdout) }; } },
    };
    expect((await readSessionColor(host, path))?.agentColor).toBe('orange');
    const none = join(dir, 'none.jsonl').replace(/\\/g, '/');
    writeFileSync(none, [long, long, long, long, long].join('\n') + '\n');
    expect(await readSessionColor(host, none)).toBeUndefined();
  });
});

// ---- console-clear.ts: always wired, refuses itself off Windows ----

function consoleHost(env: typeof WIN_ENV | undefined) {
  const writes: string[] = [];
  const idle = ['x', '\u2500'.repeat(40), '\u276f', '\u2500'.repeat(40), '  status'];
  const run = vi.fn(async (argv: readonly string[], init?: { env?: Record<string, string> }) => {
    void init;
    return argv.at(-1) === 'read'
      ? { exitCode: 0, stdout: JSON.stringify({ pid: 4242, rows: idle }) }
      : { exitCode: 0, stdout: JSON.stringify({ pid: 4242, typed: 14 }) };
  });
  return { host: { ...(env ? { env } : {}), fs: { write: async (p: string) => { writes.push(p); } }, process: { run } }, run, writes };
}

describe('console clear helper wiring', () => {
  it('Windows as the host shows it (no process.platform, OS=Windows_NT, posix dir): the helper runs', async () => {
    hostView(undefined);
    const h = consoleHost(WIN_ENV);
    expect(await consoleClear(h.host, { sessionId: 's1', dir: '/h' })).toEqual({ ok: true, pid: 4242 });
    expect(h.writes).toEqual(['\\h\\console-clear.ps1']);
    expect(h.run.mock.calls.map(c => c[0][0])).toEqual(['powershell', 'powershell']);
    expect(h.run.mock.calls[0]![0]).toContain('Hidden');
  });

  it('Windows by drive-letter dir with no env', async () => {
    hostView(undefined);
    const h = consoleHost(undefined);
    expect((await consoleClear(h.host, { sessionId: 's1', dir: 'F:/h' })).ok).toBe(true);
  });

  it('non-Windows: refused with no write and no process', async () => {
    hostView('linux');
    const h = consoleHost(POSIX_ENV);
    expect(await consoleClear(h.host, { sessionId: 's1', dir: '/h' })).toEqual({ ok: false, error: NOT_WINDOWS });
    expect(h.writes).toEqual([]);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('a busy console is still never typed into', async () => {
    hostView(undefined);
    const h = consoleHost(WIN_ENV);
    h.run.mockImplementation(async () => ({ exitCode: 0, stdout: JSON.stringify({ pid: 4242, rows: ['esc to interrupt'] }) }));
    const out = await consoleClear(h.host, { sessionId: 's1', dir: 'F:/h' });
    expect(out.ok).toBe(false);
    expect(h.run).toHaveBeenCalledTimes(1);
  });
});
