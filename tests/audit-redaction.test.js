import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, searchAuditEntries, replaySteps } from "../lib/audit-redaction.js";

test("audit search and replay redact secrets", () => {
  const secret = "sk_live_supersecretvalue";
  const entries = [
    {
      action: "query_database",
      payload: { query: "SELECT 1", connectionString: "postgres://reader:pw@db.example/analytics" },
      ok: true,
    },
    {
      action: "browser_download_file",
      payload: { url: "https://files.example.com/a", authorization: "Bearer " + secret },
      ok: true,
    },
  ];
  const found = searchAuditEntries(entries, { q: "query_database" });
  assert.equal(found.length, 1);
  const text = JSON.stringify(found);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("reader:pw"), false);
  assert.match(text, /\[redacted\]/);

  const steps = replaySteps({
    events: [
      { type: "tool", name: "gmail_send_message", args: { body: "hi", apiKey: secret } },
    ],
  });
  assert.equal(steps[0].name, "gmail_send_message");
  assert.equal(steps[0].detail.apiKey, "[redacted]");
  assert.equal(JSON.stringify(steps).includes(secret), false);
  assert.equal(redactSecrets("token " + secret).includes(secret), false);
});
