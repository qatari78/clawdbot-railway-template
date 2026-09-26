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

# Exact upstream pin. The release tag is human-readable; the SHA check is authoritative.
# Do not make this configurable at deploy time: changing OpenClaw requires a reviewed source commit.
RUN set -eux; \
  git clone --depth 1 --branch v2026.9.6 https://github.com/openclaw/openclaw.git .; \
  actual_sha="$(git rev-parse HEAD)"; \
  expected_sha="eb377ac59e6c9fd6c7705028034812becf00271b"; \
  test "$actual_sha" = "$expected_sha"; \
  printf 'OpenClaw source verified: v2026.9.6 %s\n' "$actual_sha"

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
# plugin runtime helpers instance-scoped.
COPY build/patch-whatsapp-cross-instance.cjs /tmp/patch-whatsapp-cross-instance.cjs
RUN node /tmp/patch-whatsapp-cross-instance.cjs

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
# B8 diagnostic only: include warning registration stacks in gateway stderr.
ENV NODE_OPTIONS="--trace-warnings"

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
