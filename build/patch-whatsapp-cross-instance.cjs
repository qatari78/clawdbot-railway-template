const fs = require("fs");

const runtimePath = "extensions/whatsapp/src/runtime.ts";
const testPath = "extensions/whatsapp/src/native-delivery.cross-instance.test.ts";

if (!fs.existsSync(runtimePath)) {
  throw new Error("WhatsApp runtime patch target missing: " + runtimePath);
}

let runtime = fs.readFileSync(runtimePath, "utf8");

const originalImport = [
  'import type { PluginRuntime } from "openclaw/plugin-sdk/core";',
  'import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";',
].join("\n");

const repairedImport = [
  'import type { PluginRuntime } from "openclaw/plugin-sdk/core";',
  'import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";',
  'import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";',
].join("\n");

if (!runtime.includes('resolveGlobalSingleton')) {
  if (!runtime.includes(originalImport)) {
    throw new Error("WhatsApp runtime import target not found");
  }
  runtime = runtime.replace(originalImport, repairedImport);
}

const oldOwner = [
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
  if (!runtime.includes(oldOwner)) {
    throw new Error("WhatsApp channel owner target not found");
  }
  runtime = runtime.replace(oldOwner, newOwner);
}

const oldTail = [
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

const newTail = [
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
  if (!runtime.includes(oldTail)) {
    throw new Error("WhatsApp runtime setter target not found");
  }
  runtime = runtime.replace(oldTail, newTail);
}

if (runtime.includes("fallbackToDefaultWhenInstanceEmpty")) {
  throw new Error("Unexpected generic runtime-store fallback remains in WhatsApp runtime");
}

fs.writeFileSync(runtimePath, runtime);

const test = [
  'import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";',
  'import type { PluginRuntime } from "openclaw/plugin-sdk/core";',
  'import { describe, expect, it } from "vitest";',
  'import { PluginInstance } from "../../../src/plugins/plugin-instance.js";',
  'import {',
  '  getWhatsAppConnectionController,',
  '  WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,',
  '} from "./connection-controller-runtime-context.js";',
  'import {',
  '  getOptionalWhatsAppChannelRuntime,',
  '  getWhatsAppRuntime,',
  '  setWhatsAppRuntime,',
  '} from "./runtime.js";',
  '',
  'describe("WhatsApp cross-instance native delivery", () => {',
  '  it("keeps the connection owner visible to a different managed outbound instance", async () => {',
  '    const contexts = new Map<string, unknown>();',
  '    const channel = {',
  '      runtimeContexts: {',
  '        register: ({ accountId, capability, context }: { accountId?: string; capability?: string; context: unknown }) => {',
  '          const key = (accountId ?? "") + ":" + (capability ?? "");',
  '          contexts.set(key, context);',
  '          return { dispose: () => contexts.delete(key) };',
  '        },',
  '        get: ({ accountId, capability }: { accountId?: string; capability?: string }) =>',
  '          contexts.get((accountId ?? "") + ":" + (capability ?? "")),',
  '        watch: () => () => {},',
  '      },',
  '    } as PluginRuntime["channel"];',
  '',
  '    const replacementChannel = {',
  '      runtimeContexts: {',
  '        register: () => ({ dispose: () => {} }),',
  '        get: () => undefined,',
  '        watch: () => () => {},',
  '      },',
  '    } as unknown as PluginRuntime["channel"];',
  '',
  '    const ownerRuntime = { channel } as PluginRuntime;',
  '    const outboundRuntime = { channel: replacementChannel } as PluginRuntime;',
  '    const owner = new PluginInstance("whatsapp");',
  '    const outbound = new PluginInstance("whatsapp");',
  '    const listener = {};',
  '    const controller = {',
  '      getActiveListener: () => listener,',
  '      getCurrentSock: () => null,',
  '      getSelfIdentity: () => null,',
  '    };',
  '',
  '    try {',
  '      owner.run(() => setWhatsAppRuntime(ownerRuntime));',
  '      const lease = registerChannelRuntimeContext({',
  '        channelRuntime: channel,',
  '        channelId: "whatsapp",',
  '        accountId: "default",',
  '        capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,',
  '        context: controller,',
  '      });',
  '',
  '      try {',
  '        outbound.run(() => setWhatsAppRuntime(outboundRuntime));',
  '        expect(outbound.run(() => getWhatsAppRuntime())).toBe(outboundRuntime);',
  '        expect(outbound.run(() => getOptionalWhatsAppChannelRuntime())).toBe(channel);',
  '        expect(outbound.run(() => getWhatsAppConnectionController("default"))).toBe(controller);',
  '        expect(outbound.run(() => getWhatsAppConnectionController("other"))).toBeNull();',
  '      } finally {',
  '        lease?.dispose();',
  '      }',
  '',
  '      expect(outbound.run(() => getWhatsAppConnectionController("default"))).toBeNull();',
  '    } finally {',
  '      await outbound.dispose();',
  '      await owner.dispose();',
  '    }',
  '  });',
  '});',
  '',
].join("\n");

fs.writeFileSync(testPath, test);
console.log("Applied WhatsApp cross-instance native-delivery repair");
