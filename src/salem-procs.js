import fs from "node:fs";
import path from "node:path";

// Salem AI (Claude, 2026-09-26) — R8.
// OpenClaw gateway processes in this container, found as the owners of a listening TCP socket on
// the gateway port (Linux /proc). Every OpenClaw CLI process renames itself "openclaw"
// (process.title), so the command line cannot tell the gateway from a CLI call; the listening
// port can. Used so that a stop really stops Jarvis even when the wrapper lost track of a gateway
// process (e.g. an old gateway still draining after a restart), and so the watchdog does not
// mistake a running but untracked gateway for a crash. Only pids are returned.

function listeningInodes(procDir, port) {
  const hexPort = Number(port).toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const file of ["net/tcp", "net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(path.join(procDir, file), "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1] || "";
      const state = cols[3];
      const inode = cols[9];
      if (state === "0A" && local.toUpperCase().endsWith(`:${hexPort}`) && inode && inode !== "0") inodes.add(inode);
    }
  }
  return inodes;
}

export function findGatewayPids({ port, excludePids = [], procDir = "/proc" } = {}) {
  const out = [];
  if (port == null) return out;
  const inodes = listeningInodes(procDir, port);
  if (!inodes.size) return out;
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return out; }
  const skip = new Set([process.pid, ...excludePids].filter(Boolean).map(Number));
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let fds = [];
    try { fds = fs.readdirSync(path.join(procDir, name, "fd")); } catch { continue; }
    for (const fd of fds) {
      let target = "";
      try { target = fs.readlinkSync(path.join(procDir, name, "fd", fd)); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) { out.push(pid); break; }
    }
  }
  return out;
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}
