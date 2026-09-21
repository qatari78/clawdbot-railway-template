import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function applyPrivateWorkspaceSeed(workspaceDir) {
  const raw = (process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_GZIP_B64 || process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_JSON)?.trim();
  if (!raw) return { applied: false, reason: "no-seed" };

  let spec;
  try {
    const bytes = Buffer.from(raw, "base64");
    const decoded = process.env.OPENCLAW_PRIVATE_WORKSPACE_SEED_GZIP_B64
      ? zlib.gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8");
    spec = JSON.parse(decoded);
  } catch (err) {
    console.warn("[workspace-seed] invalid seed payload");
    return { applied: false, reason: "invalid-seed" };
  }

  const root = path.resolve(workspaceDir);
  const backupDir = path.join(root, "memory", ".seed-backups", String(spec.id || "private-seed"));

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  for (const item of Array.isArray(spec.files) ? spec.files : []) {
    const rel = String(item.path || "");
    const dst = path.resolve(root, rel);
    if (!rel || !(dst === root || dst.startsWith(root + path.sep))) continue;

    const body = String(item.content || "").trimEnd() + "\n";
    const mode = item.mode === "append" ? "append" : "create";

    fs.mkdirSync(path.dirname(dst), { recursive: true });

    if (fs.existsSync(dst)) {
      const old = fs.readFileSync(dst, "utf8");

      if (item.marker && old.includes(String(item.marker))) {
        console.log("[workspace-seed] already present " + rel);
        continue;
      }

      if (mode === "create") {
        console.log("[workspace-seed] preserved existing " + rel);
        continue;
      }

      const safe = rel.replaceAll("/", "__");
      const backup = path.join(backupDir, safe + ".preseed");
      if (!fs.existsSync(backup)) fs.copyFileSync(dst, backup);

      fs.writeFileSync(dst, old.trimEnd() + "\n\n" + body, { encoding: "utf8", mode: 0o600 });
      console.log("[workspace-seed] appended " + rel);
    } else {
      fs.writeFileSync(dst, body, { encoding: "utf8", mode: 0o600 });
      console.log("[workspace-seed] created " + rel);
    }

    try { fs.chmodSync(dst, 0o600); } catch {}
  }

  return { applied: true };
}
