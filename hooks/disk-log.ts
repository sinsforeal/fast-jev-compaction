/** 0.5.24: one append for the shared disk log (`~/.claude/fast-jev-compaction.log`).
 *
 * Every session on a machine writes the same file, from its own process. The host has no
 * append call and no exclusive create (`$.fs` is read, write, list, exists, stat, ancestors),
 * so a line is added as read + write of the whole file. Two writers that read before either
 * wrote make the later write replace the earlier line. 0.5.23 and before lost lines that way:
 * on 11-12 two of six sessions restarted together never got their `module-loaded` receipt.
 *
 * The fix is verify-after-write: write, wait a few ms for a writer that read before us to land,
 * read the file back, and if our line is gone, read again and append it again. A line lost to
 * a later write is put back by the writer that lost it. Bounded: MAX_TRIES writes, and no new
 * try once BUDGET_MS has passed, so a turn is never held for about more than a second.
 * On giving up the last write is already on disk, as before. A write that throws throws to the
 * caller, which never lets a log failure change a cut. */

export type DiskLogFs = {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
};

/** Over this many characters the log is cut to its newest half before the next line. */
export const LOG_KEEP_CHARS = 512_000;
const SETTLE_MS = 25;
const MAX_TRIES = 4;
const BUDGET_MS = 900;
let settleMs = SETTLE_MS;

/** Test seam. The suite sets 0 (tests/setup.ts) so a log line costs no wall time and the many
 * tests that wait on `setImmediate` keep their timing; the concurrent-writer tests set a few ms. */
export function setLogSettleMs(ms: number): void { settleMs = ms; }

/** A short real wait. `$.clock.sleep` is no use here (tests fake it as a never-ending pause);
 * the timer is the engine's global when it has one, and no wait when it has none. */
async function settle(ms: number): Promise<void> {
  if (ms <= 0) return;
  const set =(globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  if (typeof set !== 'function') return;
  await new Promise<void>(resolve => { set(() => resolve(), ms); });
}

async function readLog(fs: DiskLogFs, path: string): Promise<string> {
  try { return (await fs.exists(path)) ? await fs.read(path) : ''; } catch { return ''; }
}

/** `entry` is the whole line with its newline. */
export async function appendDiskLine(fs: DiskLogFs, path: string, entry: string): Promise<void> {
  const started = Date.now();
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let prior = await readLog(fs, path);
    if (attempt > 0 && prior.includes(entry)) return;
    if (prior.length > LOG_KEEP_CHARS) prior = prior.slice(prior.length - LOG_KEEP_CHARS / 2);
    await fs.write(path, `${prior}${entry}`);
    if (attempt === MAX_TRIES - 1 || Date.now() - started > BUDGET_MS) return;
    await settle(settleMs);
    let back: string;
    try { back = await fs.read(path); } catch { return; }
    if (back.includes(entry)) return;
  }
}
