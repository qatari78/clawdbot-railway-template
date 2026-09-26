import fs from "node:fs";
import path from "node:path";

// Salem AI (Claude, 2026-09-26) — R8.
// OpenClaw gateway processes in this container, found through /proc (Linux). Used so that a
// stop really stops Jarvis even when the wrapper lost track of a gateway process (e.g. an old
// gateway still draining after a restart), and so the watchdog does not mistake a running but
// untracked gateway for a crash. Only pids are returned: the command line carries the gateway
// token and is never logged or returned.
export function findGatewayPids({ port, excludePids = [], procDir = "/proc" } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return out; }
  const skip = new Set([process.pid, ...excludePids].filter(Boolean).map(Number));
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let args;
    try { args = fs.readFileSync(path.join(procDir, name, "cmdline"), "utf8").split("\0"); } catch { continue; }
    const g = args.indexOf("gateway");
    if (g < 0 || args[g + 1] !== "run") continue;
    const p = args.indexOf("--port");
    if (port != null && (p < 0 || args[p + 1] !== String(port))) continue;
    out.push(pid);
  }
  return out;
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}
