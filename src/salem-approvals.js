import crypto from "node:crypto";

// D4 owner approvals (Claude, 2026-09-26). A one-time 6-digit code is sent straight to the
// owner (Telegram Bot API, outside the gateway, so no agent session ever contains it) and must
// be presented back to unlock the action. Codes live only in the wrapper's memory, expire after
// 30 minutes, are single-use, and are cancelled after 3 wrong tries.

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createOwnerApprovals({ send, now = () => Date.now(), ttlMs = 30 * 60 * 1000, randomCode } = {}) {
  const pending = new Map();
  const keyOf = (kind, ref) => `${kind}:${ref}`;
  const validKind = (kind) => /^[a-z0-9-]{3,40}$/.test(String(kind || ""));
  const validRef = (ref) => /^[A-Za-z0-9_-]{4,80}$/.test(String(ref || ""));

  async function request(kind, ref, summary) {
    if (!validKind(kind) || !validRef(ref)) return { ok: false, status: 400, error: "bad kind/ref" };
    const code = randomCode ? randomCode() : String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(salt + code).digest("hex");
    const expires = now() + ttlMs;
    const text = `🔐 Salem AI approval request\n${String(summary || kind).slice(0, 600)}\n\nYour code: ${code.slice(0, 3)} ${code.slice(3)}\nSend it to Jarvis only if you approve. Expires in 30 minutes. If you did not expect this, ignore it.`;
    const sent = await send(text);
    if (!sent?.ok) return { ok: false, status: 502, error: "could not reach the owner's Telegram" };
    pending.set(keyOf(kind, ref), { hash, salt, expires, attempts: 0 });
    return { ok: true, expiresAt: new Date(expires).toISOString() };
  }

  function verify(kind, ref, code) {
    const key = keyOf(kind, ref);
    const p = pending.get(key);
    if (!p) return { ok: false, status: 403, error: "no pending approval for this item (request one first)" };
    if (now() > p.expires) { pending.delete(key); return { ok: false, status: 403, error: "code expired; request a new one" }; }
    p.attempts += 1;
    const digits = String(code ?? "").replace(/\D/g, "");
    const hash = crypto.createHash("sha256").update(p.salt + digits).digest("hex");
    if (!safeEqualHex(hash, p.hash)) {
      if (p.attempts >= 3) pending.delete(key);
      return { ok: false, status: 403, error: p.attempts >= 3 ? "wrong code; approval cancelled after 3 tries" : "wrong code" };
    }
    pending.delete(key);
    return { ok: true };
  }

  return { request, verify, pendingCount: () => pending.size };
}

// Only processes inside this container may call the approval endpoints: the TCP peer must be
// loopback and the request must not have passed through Railway's edge proxy.
export function isLoopbackRequest(req) {
  const ip = String(req?.socket?.remoteAddress || "");
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return loopback && !req?.headers?.["x-forwarded-for"] && !req?.headers?.["x-real-ip"];
}
