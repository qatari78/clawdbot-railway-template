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

// All descendants of rootPid (children, grandchildren, …) from /proc/<pid>/stat parent links.
// Must be taken BEFORE the root is killed: orphans are re-parented to PID 1 and lose the link.
export function descendantPids(rootPid, { procDir = "/proc" } = {}) {
  const children = new Map();
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return []; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat = "";
    try { stat = fs.readFileSync(path.join(procDir, name, "stat"), "utf8"); } catch { continue; }
    // "pid (comm) state ppid …" — comm may contain spaces or parentheses; read after the last ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    if (!Number.isFinite(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(name));
  }
  const out = [];
  const queue = [Number(rootPid)];
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    for (const c of children.get(p) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}
