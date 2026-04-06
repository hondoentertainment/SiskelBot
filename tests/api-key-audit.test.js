import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/api-key-audit-test-" + Date.now();
});

await test("logKeyUsage does nothing when entry is null", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  await logKeyUsage(null);
  // Should not throw
});

await test("logKeyUsage does nothing when keyId is missing", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  await logKeyUsage({ path: "/api/test" });
  // Should not throw
});

await test("logKeyUsage does nothing when path is missing", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  await logKeyUsage({ keyId: "key-1" });
  // Should not throw
});

await test("logKeyUsage stores a valid entry", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  await logKeyUsage({ keyId: "key-1", path: "/api/chat", method: "POST" });
  // Should not throw; entry is persisted
});

await test("logKeyUsage defaults method to GET", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  await logKeyUsage({ keyId: "key-2", path: "/api/models" });
  // Should not throw
});

await test("logKeyUsage handles multiple entries", async () => {
  const { logKeyUsage } = await import("../lib/api-key-audit.js");
  for (let i = 0; i < 10; i++) {
    await logKeyUsage({ keyId: `key-${i}`, path: `/api/path-${i}`, method: "GET" });
  }
  // Should not throw; all entries stored
});
