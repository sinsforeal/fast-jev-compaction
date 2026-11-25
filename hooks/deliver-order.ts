/**
 * 0.5.33: delivery routes for a handoff order whose `$.prompt.submit` was dropped or failed.
 *
 * The host refuses a plugin's submit after a stop ("the session was stopped and nobody has sent input since"),
 * and a session that only gets input through channels never gets that input. The order must still arrive, so
 * the dropped submit falls through to (1) the console route (hooks/console-clear.ts, types the line into the idle
 * console) and (2) the meta peer channel (tools/peer/send.py of the orchestrator tree, started through
 * `$.process.run`). The host has no "session can take input now" event (types/claude-code.d.ts: a plugin's
 * submit "runs once the session is idle", nothing announces that a stopped session may take one), so no retry route.
 *
 * Loader rules (0.5.26 to 0.5.28, 0.5.32): `$` is never bound, a host member is only called, inside try.
 */

export type PeerSendResult = { ok: true; detail: string } | { ok: false; error: string };

type PeerHost = {
  fs: { write: (path: string, text: string) => Promise<void> };
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> };
};

/** The orchestrator tree whose `tools/peer/send.py` carries the message. */
export const PEER_ROOT = 'F:/REPS2/Meta_Orchestrator';

/**
 * The helper, written next to the handoff files. Env in: FJ_ROOT, FJ_CWD, FJ_TEXT. One JSON line out.
 * The tree comes from the session cwd (`peerlib.tree_of_cwd`). The sender is the machine sender `heartbeat`
 * named `fast-jev-compaction`: the helper runs under the target session's own claude process, so a sender
 * taken from the process chain would be the target itself and send.py refuses "a session does not message itself".
 * `act=True` starts a stopped tree and skips the channel's hold for machine messages.
 */
export const PEER_HELPER_PY = String.raw`import json, os, sys
def out(ok, text):
    print(json.dumps({"ok": ok, "detail" if ok else "error": str(text)[:300]}))
    sys.exit(0 if ok else 2)
try:
    root = os.environ["FJ_ROOT"]
    sys.path.insert(0, os.path.join(root, "tools", "peer"))
    sys.path.insert(0, os.path.join(root, "tools"))
    import peerlib, send
    tree = peerlib.tree_of_cwd(os.environ.get("FJ_CWD", ""))
    if not tree:
        out(False, "cwd %r is in no known tree" % os.environ.get("FJ_CWD", ""))
    ok, route, detail = send.send(tree, os.environ["FJ_TEXT"], from_tree=peerlib.SYSTEM_TREE, from_name="fast-jev-compaction", act=True)
    out(ok, "%s to %s: %s" % (route, tree, detail))
except SystemExit:
    raise
except Exception as e:
    out(False, "%s: %s" % (type(e).__name__, e))
`;

/** Python takes either separator; keep the one the directory already uses. */
const nativeJoin = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;

/** Last JSON line of stdout, or undefined. */
function lastJson(stdout: string | undefined): Record<string, unknown> | undefined {
  const lines = String(stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]!) as Record<string, unknown>; } catch { /* the line before */ }
  }
  return undefined;
}

/**
 * Sends `text` to the session's tree through the meta peer channel with `--act` semantics. Never throws; every
 * failure comes back as `{ ok: false, error }`. `cwd` is the session's tree root (or any path under it).
 */
export async function peerSend(host: PeerHost, input: { dir: string; cwd: string; text: string; root?: string }): Promise<PeerSendResult> {
  try {
    const script = nativeJoin(input.dir, 'peer-send.py');
    await host.fs.write(script, PEER_HELPER_PY);
    const res = await host.process.run(['python', script], {
      timeoutMs: 60_000,
      env: { FJ_ROOT: input.root ?? PEER_ROOT, FJ_CWD: input.cwd, FJ_TEXT: input.text },
    });
    const seen = lastJson(res.stdout);
    if (!seen) return { ok: false, error: `peer helper returned nothing (exit ${res.exitCode}${res.stderr ? `; ${String(res.stderr).replace(/\s+/g, ' ').slice(0, 160)}` : ''})` };
    if (seen.ok === true) return { ok: true, detail: String(seen.detail ?? '').slice(0, 200) };
    return { ok: false, error: String(seen.error ?? `exit ${res.exitCode}`).slice(0, 200) };
  } catch (error) {
    return { ok: false, error: `peer send threw: ${String((error as { message?: unknown } | undefined)?.message ?? error).replace(/\s+/g, ' ').slice(0, 160)}` };
  }
}
