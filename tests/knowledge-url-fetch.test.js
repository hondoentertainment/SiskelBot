import { describe, it } from "node:test";
import assert from "node:assert";
import { isUrlAllowedForKnowledge } from "../lib/knowledge-url-fetch.js";

describe("knowledge-url-fetch allowlist", () => {
  it("allows exact host match", () => {
    assert.strictEqual(
      isUrlAllowedForKnowledge("https://example.com/doc", ["example.com"]),
      true
    );
  });

  it("allows subdomain of listed host", () => {
    assert.strictEqual(
      isUrlAllowedForKnowledge("https://raw.githubusercontent.com/o/r/main/README.md", ["raw.githubusercontent.com"]),
      true
    );
  });

  it("allows URL prefix entries", () => {
    assert.strictEqual(
      isUrlAllowedForKnowledge("https://example.com/docs/page", ["https://example.com/docs/"]),
      true
    );
    assert.strictEqual(
      isUrlAllowedForKnowledge("https://evil.com/docs/page", ["https://example.com/docs/"]),
      false
    );
  });

  it("rejects non-http(s)", () => {
    assert.strictEqual(isUrlAllowedForKnowledge("ftp://example.com/x", ["example.com"]), false);
  });
});
