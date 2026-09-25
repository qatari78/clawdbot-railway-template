# OpenClaw Patch Inventory

This image is built from OpenClaw **v2026.9.6** at commit
`eb377ac59e6c9fd6c7705028034812becf00271b`. The Docker build verifies the
checkout SHA and fails if it differs.

The items below are local compatibility changes applied on top of that exact
upstream source. Review each one before changing the OpenClaw pin.

## 1. Extension dependency compatibility

**Location:** `Dockerfile`

The build normalizes extension `package.json` references to the host
`openclaw` package when they use unpublished minimum-version or
`workspace:*` constraints. This exists to keep the source build installable
when extension manifests reference workspace-only package versions.

**Validation:** the subsequent `pnpm install` and full OpenClaw build must
complete successfully.

## 2. Browser dashboard-selector compatibility

**Location:** inline Node patch in `Dockerfile`

When an ordinary browser URL navigation also carries a dashboard selector, the
patch discards the dashboard selector and treats the request as normal managed
browser navigation. The patch requires the expected upstream source snippet
when the target file exists, so source drift fails the build rather than
silently applying a different edit.

**Removal condition:** upstream browser handling makes the compatibility shim
unnecessary.

## 3. WhatsApp cross-instance native delivery

**Location:** `build/patch-whatsapp-cross-instance.cjs`

This keeps the connection-owning WhatsApp channel runtime process-wide while
ordinary plugin runtime helpers remain instance-scoped. It addresses the case
where an agent turn cannot see the active WhatsApp Web listener even though the
channel is connected.

**Build gates:**
- `extensions/whatsapp/src/native-delivery.cross-instance.test.ts`
- `extensions/whatsapp/src/connection-controller.test.ts`

Both tests must pass before the image is built.
