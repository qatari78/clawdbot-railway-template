// Salem AI wrapper watchdog (Claude, 2026-09-26) — B2.
// Runs as a separate process next to the wrapper. If the wrapper stops answering its
// own liveness endpoint for ~3 minutes (hung event loop), kill it so Railway's restart
// policy brings the container back. The wrapper itself supervises the OpenClaw gateway;
// this process only covers the case where the wrapper is the thing that froze.

const wrapperPid = Number.parseInt(process.env.WATCHDOG_WRAPPER_PID || "", 10);
const port = Number.parseInt(process.env.WATCHDOG_PORT || process.env.PORT || "8080", 10);
const intervalMs = 30_000;
const maxFailures = 6; // 6 × 30 s = 3 minutes of silence
const graceMs = 5 * 60 * 1000; // never act in the first 5 minutes after boot
const startedAt = Date.now();
let failures = 0;

function wrapperAlive() {
  try { process.kill(wrapperPid, 0); return true; } catch { return false; }
}

async function tick() {
  if (!Number.isFinite(wrapperPid) || !wrapperAlive()) process.exit(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/setup/healthz`, { signal: AbortSignal.timeout(10_000) });
    failures = res.ok ? 0 : failures + 1;
  } catch {
    failures += 1;
  }
  if (failures >= maxFailures && Date.now() - startedAt > graceMs) {
    console.error(`[wrapper-watchdog-v1] wrapper unresponsive for ${failures * 30}s — killing pid ${wrapperPid} so Railway restarts the container`);
    try { process.kill(wrapperPid, "SIGKILL"); } catch {}
    process.exit(1);
  }
}

console.log(`[wrapper-watchdog-v1] watching wrapper pid ${wrapperPid} on :${port}`);
setInterval(() => { void tick(); }, intervalMs).unref?.();
setInterval(() => {}, 1 << 30); // keep the process alive
