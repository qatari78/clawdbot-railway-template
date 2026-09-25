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
RUN printf '[openclaw-build-ref] requested=%s\\n' "${OPENCLAW_GIT_REF}" \
  && printf '[openclaw-build-ref] head=' && git rev-parse HEAD \
  && printf '[openclaw-build-ref] describe=' && git describe --tags --always --dirty

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

# Diagnostic only: expose the first WhatsApp durable-delivery failure.
# Logs contain queue state and error metadata only; they do not log message text or recipient.
RUN node <<'NODE'
const fs = require("fs");

const execPath = "src/infra/outbound/deliver-queue-execute.ts";
const queuePath = "src/infra/outbound/deliver-queue.ts";
for (const p of [execPath, queuePath]) {
  if (!fs.existsSync(p)) throw new Error(`WhatsApp delivery diagnostic target missing: ${p}`);
}

let execSource = fs.readFileSync(execPath, "utf8");
if (!execSource.includes("[whatsapp-live-delivery-diagnostic]")) {
  const needle = `  } catch (caughtError) {
    let err = caughtError;`;
  const replacement = `  } catch (caughtError) {
    if (params.channel === "whatsapp") {
      const diagnosticError =
        caughtError instanceof Error ? caughtError : new Error(formatErrorMessage(caughtError));
      const diagnosticCode =
        typeof caughtError === "object" &&
        caughtError !== null &&
        "code" in caughtError
          ? String((caughtError as { code?: unknown }).code ?? "")
          : "";
      log.warn(
        \\`[whatsapp-live-delivery-diagnostic] queueId=\\${queueId ?? "none"} producerClaim=\\${producerClaimId ? "present" : "missing"} custody=\\${queueOwner?.custody ?? "none"} platformSendStarted=\\${platformSendStarted} preSend=\\${queuedPreSendState ?? "none"} postSend=\\${queuedPostSendState ?? "none"} results=\\${deliveredResults.length} aborted=\\${Boolean(params.abortSignal?.aborted)} errorName=\\${diagnosticError.name} errorCode=\\${diagnosticCode || "none"} error=\\${formatErrorMessage(caughtError)}\\`,
      );
    }
    let err = caughtError;`;
  if (!execSource.includes(needle)) {
    throw new Error("deliver-queue-execute diagnostic insertion point not found");
  }
  execSource = execSource.replace(needle, replacement);
  fs.writeFileSync(execPath, execSource);
}

let queueSource = fs.readFileSync(queuePath, "utf8");
if (!queueSource.includes("[whatsapp-queue-handoff-diagnostic]")) {
  const needle = `  } catch (error) {
    throw queueOwner ? queueOwner.project(error) : error;
  }
}`;
  const replacement = `  } catch (error) {
    if (channel === "whatsapp") {
      log.warn(
        \\`[whatsapp-queue-handoff-diagnostic] queueId=\\${queueId ?? "none"} created=\\${queued?.created === true} producerClaim=\\${queued?.producerClaimId ? "present" : "missing"} custody=\\${queueOwner?.custody ?? "none"} reusePending=\\${Boolean(params.reusePendingDeliveryIntent)} stableClaim=\\${stableIntentClaimHeld} aborted=\\${Boolean(params.abortSignal?.aborted)} error=\\${formatErrorMessage(error)}\\`,
      );
    }
    throw queueOwner ? queueOwner.project(error) : error;
  }
}`;
  const idx = queueSource.lastIndexOf(needle);
  if (idx < 0) {
    throw new Error("deliver-queue diagnostic insertion point not found");
  }
  queueSource =
    queueSource.slice(0, idx) + replacement + queueSource.slice(idx + needle.length);
  fs.writeFileSync(queuePath, queueSource);
}
NODE

RUN pnpm install --no-frozen-lockfile
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
