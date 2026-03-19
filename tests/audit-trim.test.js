import { describe, it } from "node:test";
import assert from "node:assert";
import { trimAuditEntries } from "../lib/audit-trim.js";

describe("audit-trim (Phase 52)", () => {
  it("keeps last N entries when over max", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ timestamp: new Date(i * 1000).toISOString(), n: i }));
    const out = trimAuditEntries(entries, 3, null);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[2].n, 4);
  });

  it("filters by retention days", () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const out = trimAuditEntries(
      [{ timestamp: old }, { timestamp: recent }],
      1000,
      30
    );
    assert.strictEqual(out.length, 1);
  });
});
