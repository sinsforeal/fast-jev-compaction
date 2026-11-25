/**
 * 0.5.31: one Windows check for every hook file.
 *
 * Until 0.5.30 each file had its own `onWindows()` reading `globalThis.process?.platform`. In the plugin host
 * `globalThis.process` is not usable, so it was false in every session on the Windows 11 PC (log 11-18: readTail
 * chose `sh`, handoff.ts deleted with `rm -f`, color-carry used grep, the console clear helper was left undefined).
 *
 * Order here:
 *   1. `process.platform === 'win32'` when the host exposes it (a test run, a plain node host). Only a yes counts.
 *   2. a drive-letter or UNC path among the paths the caller is about to use (`F:/h/...`, `C:\Users\...`).
 *      A path like that cannot be a posix path; this needs no host call and is how the 0.5.26 follow-up proposed it.
 *   3. `$.env.get('OS') === 'Windows_NT'` (set by Windows for every process, claude.exe included).
 *   4. `$.env.get('SystemRoot')` set to a drive-letter path (a stripped env that lost OS).
 * Nothing here throws; a host with no `env` answers from the paths alone.
 */

export type PlatformHost = { env?: { get: (name: string) => Promise<string | undefined> } };

/**
 * Where the process platform comes from. A mutable object so a test can run both branches on one machine;
 * nothing else touches it.
 */
export const platformSource = {
  processPlatform: (): string | undefined => {
    const platform = (globalThis as { process?: { platform?: unknown } }).process?.platform;
    return typeof platform === 'string' && platform ? platform : undefined;
  },
};

/** `F:/x`, `F:\x`, `\\server\share`: a path only Windows gives. */
export const isWindowsPath = (path: string | undefined): boolean =>
  typeof path === 'string' && (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path));

/** True on Windows. `hints` are paths the caller is about to use. Never throws. */
export async function detectWindows(host: PlatformHost | undefined, hints: readonly (string | undefined)[] = []): Promise<boolean> {
  // Only a positive answer is trusted: a host shim of `process` that says something else is not proof.
  if (platformSource.processPlatform() === 'win32') return true;
  if (hints.some(isWindowsPath)) return true;
  // 0.5.32: no existence test on host.env (the loader refuses `host?.env &&` as a value use, 0.5.28 rule);
  // a host with no env (or no host) throws inside the try and the next signal runs.
  try {
    if ((await host!.env!.get('OS')) === 'Windows_NT') return true;
  } catch { /* try the next signal */ }
  try {
    if (isWindowsPath(await host!.env!.get('SystemRoot'))) return true;
  } catch { /* no env, not Windows as far as we can tell */ }
  return false;
}

/** The path with backslashes, for a native Windows command line (cmd, findstr). */
export const nativeWindowsPath = (path: string): string => path.replace(/\//g, '\\');
