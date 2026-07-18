import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setRetentionPolicy, enforceRetention, setLegalHold, getRetentionPolicy } from "../lib/data-retention.js";
import { mapAuditEventToControls, ISO27001_CONTROLS, generateISO27001Report } from "../lib/compliance.js";

describe("legal hold + ISO27001", () => {
  let dir;
  const prev = process.env.STORAGE_PATH;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "siskel-retention-"));
    process.env.STORAGE_PATH = dir;
  });

  after(() => {
    if (prev === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("blocks enforce while legal hold is active", async () => {
    await setRetentionPolicy("holdws", { conversationsTTLDays: 1, legalHold: false });
    await setLegalHold("holdws", { enabled: true, reason: "litigation" });
    const policy = await getRetentionPolicy("holdws");
    assert.equal(policy.legalHold, true);
    const result = await enforceRetention("holdws");
    assert.equal(result.legalHold, true);
    assert.equal(result.deleted.skippedLegalHold, true);
  });

  it("maps audit events to ISO 27001 controls", () => {
    const m = mapAuditEventToControls({ action: "login_success" });
    assert.ok(Array.isArray(m.iso27001));
    assert.ok(Object.keys(ISO27001_CONTROLS).length >= 5);
  });

  it("generates ISO27001 report shape", async () => {
    const report = await generateISO27001Report({});
    assert.equal(report.framework, "ISO27001");
    assert.ok(Array.isArray(report.controls));
  });
});
