// Isolated, non-destructive restore verifier.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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

    if (fullName === required[0]) {
      configText = tar.subarray(dataStart, dataEnd).toString("utf8");
    }
    if (fullName === required[1]) {
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

async function run() {
  const date = new Date().toISOString().split("T")[0];
  const key = process.env.BACKUP_KEY || `openclaw-state-${date}.tar.gz`;

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await bodyToBytes(obj.Body);

  if (bytes.byteLength === 0) throw new Error("Downloaded backup object is empty");
  if (typeof obj.ContentLength === "number" && obj.ContentLength !== bytes.byteLength) {
    throw new Error("S3 object length does not match downloaded bytes");
  }

  const inspected = inspectTar(bytes);
  return {
    ok: true,
    key,
    bytes: bytes.byteLength,
    entries: inspected.entries,
    configBytes: inspected.configBytes,
    agentsBytes: inspected.agentsBytes,
    topLevels: inspected.topLevels,
  };
}

run()
  .then((result) => {
    console.log("RESTORE_PROOF_OK " + JSON.stringify(result));
  })
  .catch((err) => {
    console.error("RESTORE_PROOF_FAILED " + String(err?.message || err));
    process.exit(1);
  });
