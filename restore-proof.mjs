// Isolated, non-destructive restore verifier.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";

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

function inspectTar(gzipData) {
  const tar = gunzipSync(gzipData);
  let offset = 0;
  let entries = 0;
  let configText = null;
  let agentsText = null;
  const topLevels = new Set();

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/, "").trim();
    const name = field(0, 100);
    const prefix = field(345, 500);
    const fullName = prefix ? `${prefix}/${name}` : name;

    if (!fullName) throw new Error("Backup archive contains unnamed entry");
    const normalizedName = fullName.replace(/^\.\//, "");
    const topLevel = normalizedName.split("/")[0];
    if (topLevel && topLevel !== ".") topLevels.add(topLevel);
    if (fullName.startsWith("/") || fullName.split("/").includes("..")) {
      throw new Error(`Unsafe backup archive path: ${fullName}`);
    }

    const sizeText = field(124, 136);
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar size for ${fullName}`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`Truncated tar entry: ${fullName}`);

    if (normalizedName === required[0]) {
      configText = tar.subarray(dataStart, dataEnd).toString("utf8");
    }
    if (normalizedName === required[1]) {
      agentsText = tar.subarray(dataStart, dataEnd).toString("utf8");
    }

    entries += 1;
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (entries === 0) throw new Error("Backup archive contains no entries");
  if (!configText) throw new Error(`Missing ${required[0]}`);
  if (!agentsText || !agentsText.trim()) throw new Error(`Missing or empty ${required[1]}`);

  const requiredTopLevels = [".openclaw", "workspace", "jarvis-research", "agent-workspaces"];
  for (const name of requiredTopLevels) {
    if (!topLevels.has(name)) throw new Error(`Missing required /data area: ${name}`);
  }

  const cfg = JSON.parse(configText);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("openclaw.json is not a JSON object");
  }

  return {
    entries,
    configBytes: Buffer.byteLength(configText),
    agentsBytes: Buffer.byteLength(agentsText),
    topLevels: [...topLevels].sort(),
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
  const inspected = inspectTar(bytes);

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

  const liveInspection = inspectTar(exported);

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

  const persistedInspection = inspectTar(persisted);
  return {
    ok: true,
    key,
    exportedBytes: exported.byteLength,
    persistedBytes: persisted.byteLength,
    entries: persistedInspection.entries,
    configBytes: persistedInspection.configBytes,
    agentsBytes: persistedInspection.agentsBytes,
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
