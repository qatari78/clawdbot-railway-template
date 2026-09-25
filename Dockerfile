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

# WhatsApp live-listener runtime fix:
# Outbound sends can execute inside a plugin-instance scope whose named slot exists
# but is still null. That empty instance slot must not mask WhatsApp's deliberately
# process-lifetime channel-context-owner runtime. Make fallback opt-in so generic
# plugin-instance isolation semantics remain unchanged, and keep writes instance-scoped.
RUN node <<'NODE'
const fs = require("fs");

const storePath = "src/plugin-sdk/runtime-store.ts";
const waPath = "extensions/whatsapp/src/runtime.ts";
const testPath = "src/plugin-sdk/runtime-store.test.ts";

for (const p of [storePath, waPath, testPath]) {
  if (!fs.existsSync(p)) throw new Error(`WhatsApp runtime patch target missing: ${p}`);
}

let store = fs.readFileSync(storePath, "utf8");

if (!store.includes("fallbackToDefaultWhenInstanceEmpty")) {
  const keyTypeNeedle = `type PluginRuntimeStoreKeyOptions = {
  /** Explicit global registry key for shared runtime slots. */
  key: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};`;
  const keyTypeReplacement = `type PluginRuntimeStoreKeyOptions = {
  /** Explicit global registry key for shared runtime slots. */
  key: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
  /** Read the named process-lifetime slot when the active instance slot is empty. */
  fallbackToDefaultWhenInstanceEmpty?: boolean;
};`;
  if (!store.includes(keyTypeNeedle)) throw new Error("runtime-store key options patch target not found");
  store = store.replace(keyTypeNeedle, keyTypeReplacement);

  const pluginTypeNeedle = `type PluginRuntimeStorePluginOptions = {
  /** Plugin id used to derive a stable cross-module runtime slot key. */
  pluginId: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};`;
  const pluginTypeReplacement = `type PluginRuntimeStorePluginOptions = {
  /** Plugin id used to derive a stable cross-module runtime slot key. */
  pluginId: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
  /** Read the named process-lifetime slot when the active instance slot is empty. */
  fallbackToDefaultWhenInstanceEmpty?: boolean;
};`;
  if (!store.includes(pluginTypeNeedle)) throw new Error("runtime-store plugin options patch target not found");
  store = store.replace(pluginTypeNeedle, pluginTypeReplacement);

  const resolveNeedle = `    return {
      key: pluginRuntimeStoreKeyForPluginId(options.pluginId),
      errorMessage: options.errorMessage,
    };`;
  const resolveReplacement = `    return {
      key: pluginRuntimeStoreKeyForPluginId(options.pluginId),
      errorMessage: options.errorMessage,
      fallbackToDefaultWhenInstanceEmpty: options.fallbackToDefaultWhenInstanceEmpty,
    };`;
  if (!store.includes(resolveNeedle)) throw new Error("runtime-store resolve options patch target not found");
  store = store.replace(resolveNeedle, resolveReplacement);

  const runtimeNeedle = `  const resolveSlot = () => getPluginInstanceRuntimeSlot(instanceKey) ?? defaultSlot;

  return {
    setRuntime(next: T) {
      resolveSlot().runtime = next;
    },
    clearRuntime() {
      resolveSlot().runtime = null;
    },
    tryGetRuntime() {
      return (resolveSlot().runtime as T | null) ?? null;
    },
    getRuntime() {
      const slot = resolveSlot();
      if (slot.runtime == null) {
        throw new Error(resolved.errorMessage);
      }
      return slot.runtime as T;
    },
  };`;
  const runtimeReplacement = `  const resolveSlot = () => getPluginInstanceRuntimeSlot(instanceKey) ?? defaultSlot;
  const readRuntime = (): T | null => {
    const instanceSlot = getPluginInstanceRuntimeSlot(instanceKey);
    if (!instanceSlot) {
      return (defaultSlot.runtime as T | null) ?? null;
    }
    if (instanceSlot.runtime != null || !resolved.fallbackToDefaultWhenInstanceEmpty) {
      return (instanceSlot.runtime as T | null) ?? null;
    }
    return (defaultSlot.runtime as T | null) ?? null;
  };

  return {
    setRuntime(next: T) {
      resolveSlot().runtime = next;
    },
    clearRuntime() {
      resolveSlot().runtime = null;
    },
    tryGetRuntime() {
      return readRuntime();
    },
    getRuntime() {
      const runtime = readRuntime();
      if (runtime == null) {
        throw new Error(resolved.errorMessage);
      }
      return runtime;
    },
  };`;
  if (!store.includes(runtimeNeedle)) throw new Error("runtime-store read behavior patch target not found");
  store = store.replace(runtimeNeedle, runtimeReplacement);
  fs.writeFileSync(storePath, store);
}

let wa = fs.readFileSync(waPath, "utf8");
if (!wa.includes("fallbackToDefaultWhenInstanceEmpty: true")) {
  const waNeedle = `const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({
  key: "plugin-runtime:whatsapp:channel-context-owner",
  errorMessage: "WhatsApp channel runtime not initialized",
});`;
  const waReplacement = `const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({
  key: "plugin-runtime:whatsapp:channel-context-owner",
  errorMessage: "WhatsApp channel runtime not initialized",
  fallbackToDefaultWhenInstanceEmpty: true,
});`;
  if (!wa.includes(waNeedle)) throw new Error("WhatsApp channel runtime patch target not found");
  wa = wa.replace(waNeedle, waReplacement);
  fs.writeFileSync(waPath, wa);
}

let test = fs.readFileSync(testPath, "utf8");
if (!test.includes('from "../plugins/plugin-instance.js"')) {
  const importNeedle = 'import { describe, expect, test } from "vitest";';
  if (!test.includes(importNeedle)) throw new Error("runtime-store test import target not found");
  test = test.replace(importNeedle, importNeedle + '\nimport { PluginInstance } from "../plugins/plugin-instance.js";');
}
if (!test.includes("falls back to the named runtime only when explicitly opted in")) {
  const closing = "\n});\n";
  const idx = test.lastIndexOf(closing);
  if (idx < 0) throw new Error("runtime-store test suite closing marker not found");
  const cases = `

  test("keeps an empty instance slot isolated by default", () => {
    const store = createPluginRuntimeStore<{ value: string }>({
      key: "instance-isolation-default",
      errorMessage: "runtime not initialized",
    });
    store.setRuntime({ value: "process" });

    const instance = new PluginInstance("runtime-store-isolation-test");
    expect(instance.run(() => store.tryGetRuntime())).toBeNull();
    expect(store.getRuntime()).toEqual({ value: "process" });
  });

  test("falls back to the named runtime only when explicitly opted in", () => {
    const store = createPluginRuntimeStore<{ value: string }>({
      key: "instance-opt-in-fallback",
      errorMessage: "runtime not initialized",
      fallbackToDefaultWhenInstanceEmpty: true,
    });
    store.setRuntime({ value: "process" });

    const instance = new PluginInstance("runtime-store-fallback-test");
    instance.run(() => {
      expect(store.getRuntime()).toEqual({ value: "process" });
      store.setRuntime({ value: "instance" });
      expect(store.getRuntime()).toEqual({ value: "instance" });
      store.clearRuntime();
      expect(store.getRuntime()).toEqual({ value: "process" });
    });

    expect(store.getRuntime()).toEqual({ value: "process" });
  });
`;
  test = test.slice(0, idx) + cases + test.slice(idx);
  fs.writeFileSync(testPath, test);
}
NODE


# TEMPORARY: WhatsApp runtime visibility diagnostic instrumentation.
# Logs only opaque runtime-slot/object ids plus controller/listener presence.
# No message text, phone numbers, credentials, config values, or payloads are logged.
RUN node <<'NODE'
const fs = require("fs");

const storePath = "src/plugin-sdk/runtime-store.ts";
const controllerPath = "extensions/whatsapp/src/connection-controller-runtime-context.ts";
for (const p of [storePath, controllerPath]) {
  if (!fs.existsSync(p)) throw new Error("WhatsApp diagnostic target missing: " + p);
}

let store = fs.readFileSync(storePath, "utf8");
if (!store.includes("[wa-runtime-diag]")) {
  const helperNeedle =
    '  const instanceKey = typeof options === "string" ? Symbol(resolved.key) : resolved.key;\n';
  const helperReplacement =
    helperNeedle +
    '  const whatsappDiagnosticKey = "plugin-runtime:whatsapp:channel-context-owner";\n' +
    '  const diagnosticGlobal = globalThis as typeof globalThis & { __openclawWaRuntimeDiag?: { ids: WeakMap<object, number>; next: number } };\n' +
    '  const diagnosticRegistry = diagnosticGlobal.__openclawWaRuntimeDiag ??= { ids: new WeakMap<object, number>(), next: 1 };\n' +
    '  const diagnosticObjectId = (value: unknown): string => {\n' +
    '    if ((typeof value !== "object" && typeof value !== "function") || value === null) return "none";\n' +
    '    const objectValue = value as object;\n' +
    '    let id = diagnosticRegistry.ids.get(objectValue);\n' +
    '    if (!id) { id = diagnosticRegistry.next++; diagnosticRegistry.ids.set(objectValue, id); }\n' +
    '    return String(id);\n' +
    '  };\n' +
    '  const logWhatsAppDiagnostic = (event: string, details: Record<string, unknown>): void => {\n' +
    '    if (resolved.key !== whatsappDiagnosticKey) return;\n' +
    '    console.warn("[wa-runtime-diag] " + JSON.stringify({ event, ...details }));\n' +
    '  };\n';
  if (!store.includes(helperNeedle)) throw new Error("runtime-store diagnostic helper target not found");
  store = store.replace(helperNeedle, helperReplacement);

  const readNeedle =
    '  const readRuntime = (): T | null => {\n' +
    '    const instanceSlot = getPluginInstanceRuntimeSlot(instanceKey);\n' +
    '    if (!instanceSlot) {\n' +
    '      return (defaultSlot.runtime as T | null) ?? null;\n' +
    '    }\n' +
    '    if (instanceSlot.runtime != null || !resolved.fallbackToDefaultWhenInstanceEmpty) {\n' +
    '      return (instanceSlot.runtime as T | null) ?? null;\n' +
    '    }\n' +
    '    return (defaultSlot.runtime as T | null) ?? null;\n' +
    '  };';
  const readReplacement =
    '  const readRuntime = (): T | null => {\n' +
    '    const instanceSlot = getPluginInstanceRuntimeSlot(instanceKey);\n' +
    '    let source: "instance" | "default-fallback" | "default-no-instance";\n' +
    '    let runtime: T | null;\n' +
    '    if (!instanceSlot) {\n' +
    '      source = "default-no-instance";\n' +
    '      runtime = (defaultSlot.runtime as T | null) ?? null;\n' +
    '    } else if (instanceSlot.runtime != null || !resolved.fallbackToDefaultWhenInstanceEmpty) {\n' +
    '      source = "instance";\n' +
    '      runtime = (instanceSlot.runtime as T | null) ?? null;\n' +
    '    } else {\n' +
    '      source = "default-fallback";\n' +
    '      runtime = (defaultSlot.runtime as T | null) ?? null;\n' +
    '    }\n' +
    '    logWhatsAppDiagnostic("runtime-read", {\n' +
    '      source,\n' +
    '      instanceSlotPresent: Boolean(instanceSlot),\n' +
    '      instanceSlotId: diagnosticObjectId(instanceSlot),\n' +
    '      instanceSlotHasRuntime: instanceSlot?.runtime != null,\n' +
    '      instanceRuntimeId: diagnosticObjectId(instanceSlot?.runtime),\n' +
    '      defaultSlotId: diagnosticObjectId(defaultSlot),\n' +
    '      defaultSlotHasRuntime: defaultSlot.runtime != null,\n' +
    '      defaultRuntimeId: diagnosticObjectId(defaultSlot.runtime),\n' +
    '      selectedRuntimeId: diagnosticObjectId(runtime),\n' +
    '    });\n' +
    '    return runtime;\n' +
    '  };';
  if (!store.includes(readNeedle)) throw new Error("runtime-store diagnostic read target not found");
  store = store.replace(readNeedle, readReplacement);

  const setNeedle =
    '    setRuntime(next: T) {\n' +
    '      resolveSlot().runtime = next;\n' +
    '    },';
  const setReplacement =
    '    setRuntime(next: T) {\n' +
    '      const slot = resolveSlot();\n' +
    '      slot.runtime = next;\n' +
    '      logWhatsAppDiagnostic("runtime-set", { target: slot === defaultSlot ? "default" : "instance", slotId: diagnosticObjectId(slot), runtimeId: diagnosticObjectId(next), defaultSlotId: diagnosticObjectId(defaultSlot) });\n' +
    '    },';
  if (!store.includes(setNeedle)) throw new Error("runtime-store diagnostic set target not found");
  store = store.replace(setNeedle, setReplacement);

  const clearNeedle =
    '    clearRuntime() {\n' +
    '      resolveSlot().runtime = null;\n' +
    '    },';
  const clearReplacement =
    '    clearRuntime() {\n' +
    '      const slot = resolveSlot();\n' +
    '      const priorRuntime = slot.runtime;\n' +
    '      slot.runtime = null;\n' +
    '      logWhatsAppDiagnostic("runtime-clear", { target: slot === defaultSlot ? "default" : "instance", slotId: diagnosticObjectId(slot), priorRuntimeId: diagnosticObjectId(priorRuntime), defaultSlotId: diagnosticObjectId(defaultSlot) });\n' +
    '    },';
  if (!store.includes(clearNeedle)) throw new Error("runtime-store diagnostic clear target not found");
  store = store.replace(clearNeedle, clearReplacement);

  fs.writeFileSync(storePath, store);
}

let controller = fs.readFileSync(controllerPath, "utf8");
if (!controller.includes("[wa-runtime-diag]")) {
  const oldLines = [
    'export function getWhatsAppConnectionController(',
    '  accountId: string,',
    '): WhatsAppConnectionControllerHandle | null {',
    '  const context = getChannelRuntimeContext({',
    '    channelRuntime: getOptionalWhatsAppChannelRuntime() ?? undefined,',
    '    channelId: "whatsapp",',
    '    accountId,',
    '    capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,',
    '  });',
    '  return (context as WhatsAppConnectionControllerHandle | undefined) ?? null;',
    '}',
  ];
  const newLines = [
    'export function getWhatsAppConnectionController(',
    '  accountId: string,',
    '): WhatsAppConnectionControllerHandle | null {',
    '  const channelRuntime = getOptionalWhatsAppChannelRuntime() ?? undefined;',
    '  const context = getChannelRuntimeContext({',
    '    channelRuntime,',
    '    channelId: "whatsapp",',
    '    accountId,',
    '    capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,',
    '  });',
    '  const controller = (context as WhatsAppConnectionControllerHandle | undefined) ?? null;',
    '  const listener = controller?.getActiveListener() ?? null;',
    '  console.warn("[wa-runtime-diag] " + JSON.stringify({ event: "controller-lookup", accountId, channelRuntimePresent: Boolean(channelRuntime), controllerPresent: Boolean(controller), listenerPresent: Boolean(listener) }));',
    '  return controller;',
    '}',
  ];
  const needle = oldLines.join("\n");
  if (!controller.includes(needle)) throw new Error("WhatsApp controller diagnostic target not found");
  controller = controller.replace(needle, newLines.join("\n"));
  fs.writeFileSync(controllerPath, controller);
}
NODE

RUN pnpm install --no-frozen-lockfile
# Regression gate: do not build/deploy if runtime-store isolation/fallback tests fail.
RUN pnpm exec vitest run src/plugin-sdk/runtime-store.test.ts
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
