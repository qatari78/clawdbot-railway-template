import { GatewayChatClient } from "/openclaw/src/tui/gateway-chat.ts";

const sessionKey = process.argv[2] || "agent:main:main";
const runId = process.argv[3] || ("c1-context-" + process.pid);

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const block = part as Record<string, unknown>;
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

const client = await GatewayChatClient.connect({});
let timer: ReturnType<typeof setTimeout> | undefined;

try {
  const finalText = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("context chat event timeout")), 30_000);
    client.onConnectError = (error) => reject(error);
    client.onEvent = (event) => {
      if (event.event !== "chat") return;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      if (!payload || payload.runId !== runId) return;
      const state = typeof payload.state === "string" ? payload.state : "";
      if (state === "error" || state === "aborted") {
        reject(new Error("context chat command failed"));
        return;
      }
      if (state !== "final") return;
      const text = messageText(payload.message);
      if (!text) {
        reject(new Error("context final event had no text"));
        return;
      }
      resolve(text);
    };
  });

  client.start();
  await client.waitForReady();
  const accepted = await client.sendChat({
    sessionKey,
    agentId: "main",
    message: "/context json",
    deliver: false,
    runId,
  });
  if (accepted.runId !== runId) {
    throw new Error("context run id mismatch");
  }
  const text = await finalText;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write("\nC1_CONTEXT_B64:" + encoded + "\n");
} finally {
  if (timer) clearTimeout(timer);
  await client.stop();
}
