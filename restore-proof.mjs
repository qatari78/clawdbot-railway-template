// Isolated, non-destructive restore verifier.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

const required = [".openclaw/openclaw.json", "workspace/AGENTS.md"];
const bucket = process.env.BUCKET;
if (!bucket) throw new Error("BUCKET is not configured");

const s3 = new S3Client({
  region: process.env.REGION || "auto",
  endpoint: process.env.ENDPOINT,
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

async function bodyToBytes(body) {
  if (!body) throw new Error("Backup object body was empty");
  if (typeof body.transformToByteArray === "function") {
    return new Uint8Array(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(new Uint8Array(chunk));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function inspectTar(gzipData) {
  const tmpPath = path.join(os.tmpdir(), `backup-proof-${process.pid}-${Date.now()}.tar.gz`);
  fs.writeFileSync(tmpPath, gzipData);

  const seen = new Set();
  const topLevels = new Set();
  let entries = 0;

  try {
    await tar.t({
      file: tmpPath,
      onentry: (entry) => {
        const normalizedName = String(entry.path || "")
          .replace(/^\.\//, "")
          .replace(/\/$/, "");
        if (!normalizedName) return;
        seen.add(normalizedName);
        const topLevel = normalizedName.split("/")[0];
        if (topLevel) topLevels.add(topLevel);
        entries += 1;
      },
    });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  if (entries === 0) throw new Error("Backup archive contains no entries");

  for (const requiredPath of required) {
    if (!seen.has(requiredPath)) throw new Error(`Missing ${requiredPath}`);
  }

  const requiredTopLevels = [".openclaw", "workspace", "jarvis-research", "agent-workspaces"];
  for (const name of requiredTopLevels) {
    if (!topLevels.has(name)) throw new Error(`Missing required /data area: ${name}`);
  }

  return {
    entries,
    topLevels: [...topLevels].sort(),
    requiredPaths: required,
  };
}

async function captureLiveBackup(key) {
  if (process.env.CAPTURE_BACKUP !== "1") return null;

  const domain = (process.env.PRIMARY_SERVICE_DOMAIN || "").trim();
  const token = (process.env.BACKUP_EXPORT_TOKEN || "").trim();
  if (!domain) throw new Error("PRIMARY_SERVICE_DOMAIN is not configured");
  if (!token) throw new Error("BACKUP_EXPORT_TOKEN is not configured");

  const baseUrl = domain.includes("://")
    ? domain.replace(/\/$/, "")
    : `http://${domain}:8080`;

  const health = await fetch(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!health.ok) throw new Error(`Primary health check failed: ${health.status}`);

  const response = await fetch(`${baseUrl}/setup/export`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Backup export returned ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Live backup export was empty");

  // Fail before upload if the live export is incomplete.
  const inspected = await inspectTar(bytes);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: "application/gzip",
  }));

  console.log("BACKUP_CAPTURED " + JSON.stringify({
    key,
    bytes: bytes.byteLength,
    entries: inspected.entries,
    topLevels: inspected.topLevels,
  }));
  return bytes;
}

async function run() {
  const date = new Date().toISOString().split("T")[0];
  const key = process.env.BACKUP_KEY || `openclaw-state-${date}.tar.gz`;
  const exportToken = process.env.BACKUP_EXPORT_TOKEN || "";
  const serviceDomain = (process.env.PRIMARY_SERVICE_DOMAIN || "").trim();

  if (!exportToken) throw new Error("BACKUP_EXPORT_TOKEN is not configured");
  if (!serviceDomain) throw new Error("PRIMARY_SERVICE_DOMAIN is not configured");

  const baseUrl = serviceDomain.includes("://")
    ? serviceDomain.replace(/\/$/, "")
    : `http://${serviceDomain}:8080`;

  const response = await fetch(`${baseUrl}/setup/export`, {
    headers: { Authorization: `Bearer ${exportToken}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Backup export returned ${response.status}`);

  const exported = new Uint8Array(await response.arrayBuffer());
  if (exported.byteLength === 0) throw new Error("Live /data export was empty");

  const liveInspection = await inspectTar(exported);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: exported,
    ContentType: "application/gzip",
  }));

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const persisted = await bodyToBytes(obj.Body);
  if (persisted.byteLength === 0) throw new Error("Persisted backup object is empty");
  if (typeof obj.ContentLength === "number" && obj.ContentLength !== persisted.byteLength) {
    throw new Error("S3 object length does not match downloaded bytes");
  }

  const persistedInspection = await inspectTar(persisted);
  return {
    ok: true,
    key,
    exportedBytes: exported.byteLength,
    persistedBytes: persisted.byteLength,
    entries: persistedInspection.entries,
    topLevels: persistedInspection.topLevels,
    liveTopLevels: liveInspection.topLevels,
  };
}

run()
  .then(async (result) => {
    console.log("RESTORE_PROOF_OK " + JSON.stringify(result));
    // Give Railway's runtime log collector time to persist the proof line.
    await new Promise((resolve) => setTimeout(resolve, 10000));
  })
  .catch(async (err) => {
    console.error("RESTORE_PROOF_FAILED " + String(err?.message || err));
    await new Promise((resolve) => setTimeout(resolve, 10000));
    process.exit(1);
  });
