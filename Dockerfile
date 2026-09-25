# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:24-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

# Pin to a known-good ref (tag/branch). Override in Railway template settings if needed.
# Using a released tag avoids build breakage when `main` temporarily references unpublished packages.
ARG OPENCLAW_GIT_REF=v2026.3.8
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

# Compatibility patch for ordinary URL navigation:
# If an agent accidentally supplies a dashboard selector together with a URL,
# treat it as normal managed-browser navigation. Real dashboard opens never carry a URL.
RUN node <<'NODE'
const fs = require("fs");
const p = "extensions/browser/src/browser-tool.ts";
if (!fs.existsSync(p)) {
  console.log("browser dashboard compatibility patch skipped: target file not present on this OpenClaw ref");
  process.exit(0);
}
let s = fs.readFileSync(p, "utf8");
const old = '      const dashboardName = readStringParam(params, "dashboard");\n      let browserDashboard: BrowserDashboardResponse | undefined;';
const replacement = '      let dashboardName = readStringParam(params, "dashboard");\n' +
  '      if (dashboardName && (params.targetUrl !== undefined || params.url !== undefined)) {\n' +
  '        params = { ...params };\n' +
  '        delete params.dashboard;\n' +
  '        dashboardName = undefined;\n' +
  '      }\n' +
  '      let browserDashboard: BrowserDashboardResponse | undefined;';
if (!s.includes(old)) {
  throw new Error("browser dashboard compatibility patch target not found");
}
s = s.replace(old, replacement);
fs.writeFileSync(p, s);
NODE

# WhatsApp native-delivery repair:
# Keep the connection-owning channel runtime process-wide while leaving ordinary
# plugin runtime helpers instance-scoped. This fixes cross-instance outbound sends
# without weakening generic runtime-store isolation.
RUN node <<'NODE'
const fs = require("fs");

const runtimePath = "extensions/whatsapp/src/runtime.ts";
const testPath = "extensions/whatsapp/src/native-delivery.cross-instance.test.ts";

if (!fs.existsSync(runtimePath)) throw new Error("WhatsApp runtime patch target missing");

let runtime = fs.readFileSync(runtimePath, "utf8");

const originalImport =
  'import type { PluginRuntime } from "openclaw/plugin-sdk/core";\n' +
  'import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";';
const repairedImport =
  'import type { PluginRuntime } from "openclaw/plugin-sdk/core";\n' +
  'import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";\n' +
  'import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";';

if (!runtime.includes('resolveGlobalSingleton')) {
  if (!runtime.includes(originalImport)) throw new Error("WhatsApp runtime import target not found");
  runtime = runtime.replace(originalImport, repairedImport);
}

const oldOwner = [
  'const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({',
  '  key: "plugin-runtime:whatsapp:channel-context-owner",',
  '  errorMessage: "WhatsApp channel runtime not initialized",',
  '  fallbackToDefaultWhenInstanceEmpty: true,',
  '});',
].join("\n");

const oldOwnerVanilla = [
  'const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({',
  '  key: "plugin-runtime:whatsapp:channel-context-owner",',
  '  errorMessage: "WhatsApp channel runtime not initialized",',
  '});',
].join("\n");

const newOwner = [
  '// Active connection leases belong to the channel runtime that registered them.',
  '// Outbound delivery may run inside a different managed plugin instance, so this',
  '// owner must outlive instance replacement while account-scoped leases remain authoritative.',
  'const channelContextOwner = resolveGlobalSingleton(',
  '  Symbol.for("openclaw.whatsapp.channelContextOwner"),',
  '  (): { channel: PluginRuntime["channel"] | null } => ({ channel: null }),',
  ');',
].join("\n");

if (!runtime.includes('Symbol.for("openclaw.whatsapp.channelContextOwner")')) {
  if (runtime.includes(oldOwner)) {
    runtime = runtime.replace(oldOwner, newOwner);
  } else if (runtime.includes(oldOwnerVanilla)) {
    runtime = runtime.replace(oldOwnerVanilla, newOwner);
  } else {
    throw new Error("WhatsApp channel owner target not found");
  }
}

const oldSetter = [
  'function setWhatsAppRuntime(next: PluginRuntime): void {',
  '  // Plugin registry reloads create fresh runtime objects. Live connection leases must remain',
  '  // readable by outbound sends until their account task explicitly disposes them.',
  '  if (!channelRuntimeStore.tryGetRuntime()) {',
  '    channelRuntimeStore.setRuntime(next.channel);',
  '  }',
  '  runtimeStore.setRuntime(next);',
  '}',
  '',
  'const getWhatsAppRuntime = runtimeStore.getRuntime;',
  'const getOptionalWhatsAppRuntime = runtimeStore.tryGetRuntime;',
  'const getWhatsAppChannelRuntime = channelRuntimeStore.getRuntime;',
  'const getOptionalWhatsAppChannelRuntime = channelRuntimeStore.tryGetRuntime;',
].join("\n");

const newSetter = [
  'function setWhatsAppRuntime(next: PluginRuntime): void {',
  '  // Plugin registry reloads create fresh runtime objects. Live connection leases must remain',
  '  // readable by outbound sends until their account task explicitly disposes them.',
  '  if (!channelContextOwner.channel) {',
  '    channelContextOwner.channel = next.channel;',
  '  }',
  '  runtimeStore.setRuntime(next);',
  '}',
  '',
  'const getWhatsAppRuntime = runtimeStore.getRuntime;',
  'const getOptionalWhatsAppRuntime = runtimeStore.tryGetRuntime;',
  'function getOptionalWhatsAppChannelRuntime(): PluginRuntime["channel"] | null {',
  '  return channelContextOwner.channel;',
  '}',
  '',
  'function getWhatsAppChannelRuntime(): PluginRuntime["channel"] {',
  '  const channel = getOptionalWhatsAppChannelRuntime();',
  '  if (!channel) {',
  '    throw new Error("WhatsApp channel runtime not initialized");',
  '  }',
  '  return channel;',
  '}',
].join("\n");

if (!runtime.includes('function getOptionalWhatsAppChannelRuntime(): PluginRuntime["channel"] | null')) {
  if (!runtime.includes(oldSetter)) throw new Error("WhatsApp runtime setter target not found");
  runtime = runtime.replace(oldSetter, newSetter);
}

if (runtime.includes("fallbackToDefaultWhenInstanceEmpty")) {
  throw new Error("Generic runtime-store fallback leaked into repaired WhatsApp runtime");
}

fs.writeFileSync(runtimePath, runtime);

const test = `import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { PluginInstance } from "../../../src/plugins/plugin-instance.js";
import {
  getWhatsAppConnectionController,
  WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
} from "./connection-controller-runtime-context.js";
import {
  getOptionalWhatsAppChannelRuntime,
  getWhatsAppRuntime,
  setWhatsAppRuntime,
} from "./runtime.js";

describe("WhatsApp cross-instance native delivery", () => {
  it("keeps the connection-owning channel context visible across managed instances", async () => {
    const contexts = new Map<string, unknown>();
    const channel = {
      runtimeContexts: {
        register: ({ accountId, capability, context }: { accountId?: string; capability?: string; context: unknown }) => {
          const key = `${accountId ?? ""}:${capability ?? ""}`;
          contexts.set(key, context);
          return { dispose: () => contexts.delete(key) };
        },
        get: ({ accountId, capability }: { accountId?: string; capability?: string }) =>
          contexts.get(`${accountId ?? ""}:${capability ?? ""}`),
        watch: () => () => {},
      },
    } as PluginRuntime["channel"];

    const replacementChannel = {
      runtimeContexts: {
        get: () => undefined,
        register: () => ({ dispose: () => {} }),
        watch: () => () => {},
      },
    } as unknown as PluginRuntime["channel"];

    const ownerRuntime = { channel } as PluginRuntime;
    const outboundRuntime = { channel: replacementChannel } as PluginRuntime;
    const owner = new PluginInstance("whatsapp");
    const outbound = new PluginInstance("whatsapp");
    const listener = {};
    const controller = {
      getActiveListener: () => listener,
      getCurrentSock: () => null,
      getSelfIdentity: () => null,
    };

    try {
      owner.run(() => setWhatsAppRuntime(ownerRuntime));
      const lease = registerChannelRuntimeContext({
        channelRuntime: channel,
        channelId: "whatsapp",
        accountId: "default",
        capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
        context: controller,
      });

      try {
        outbound.run(() => setWhatsAppRuntime(outboundRuntime));

        expect(outbound.run(() => getWhatsAppRuntime())).toBe(outboundRuntime);
        expect(outbound.run(() => getOptionalWhatsAppChannelRuntime())).toBe(channel);
        expect(outbound.run(() => getWhatsAppConnectionController("default"))).toBe(controller);
        expect(outbound.run(() => getWhatsAppConnectionController("other"))).toBeNull();
      } finally {
        lease?.dispose();
      }

      expect(outbound.run(() => getWhatsAppConnectionController("default"))).toBeNull();
    } finally {
      await outbound.dispose();
      await owner.dispose();
    }
  });
});
`;

fs.writeFileSync(testPath, test);
NODE

# Regression gates: reproduce the managed-instance failure mode and preserve
# connection-controller lifecycle/account scoping before building the image.
RUN pnpm install --no-frozen-lockfile
RUN pnpm exec vitest run \
  extensions/whatsapp/src/native-delivery.cross-instance.test.ts \
  extensions/whatsapp/src/connection-controller.test.ts
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:24-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
    chromium \
  && rm -rf /var/lib/apt/lists/*

# `openclaw update` expects pnpm. Provide it in the runtime image.
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# Persist user-installed tools by default by targeting the Railway volume.
# - npm global installs -> /data/npm
# - pnpm global installs -> /data/pnpm (binaries) + /data/pnpm-store (store)
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide an openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

# Refuse to ship a wrapper image if any JavaScript module has a syntax error.
RUN npm run lint

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
