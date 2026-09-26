import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("reset handler stops gateway before deleting config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('app.post("/setup/api/reset"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 1200);
  // R8: the stop waits until the gateway is gone (hard stop), before the config is deleted.
  const stopAt = window.search(/await stopGatewayProc\(/);
  const rmAt = window.search(/fs\.rmSync\(p/);
  assert.ok(stopAt >= 0, "reset must stop the gateway");
  assert.ok(rmAt > stopAt, "config is deleted only after the gateway is stopped");
});

test("backup import stops the gateway and holds it until the files are in place", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('app.post("/setup/import"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 3000);
  const holdAt = window.indexOf("restoreInProgress = true");
  const stopAt = window.search(/await stopGatewayProc\(/);
  const extractAt = window.indexOf("await tar.x(");
  const releaseAt = window.indexOf("restoreInProgress = false");
  assert.ok(holdAt >= 0 && stopAt > holdAt && extractAt > stopAt && releaseAt > extractAt);
});
