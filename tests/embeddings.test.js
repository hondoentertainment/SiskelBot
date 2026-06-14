import test from "node:test";
import assert from "node:assert/strict";

test("embeddings: isAvailable returns false when OPENAI_API_KEY not set", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { isAvailable } = await import("../lib/embeddings.js");
  // isAvailable reads process.env directly each time
  assert.equal(isAvailable(), false);
});

test("embeddings: isAvailable returns true when OPENAI_API_KEY is set", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-fake-key";
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { isAvailable } = await import("../lib/embeddings.js");
  assert.equal(isAvailable(), true);
});

test("embeddings: embed returns null when OPENAI_API_KEY not set", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embed } = await import("../lib/embeddings.js");
  const result = await embed("hello world");
  assert.equal(result, null);
});

test("embeddings: embed returns null for empty string", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embed } = await import("../lib/embeddings.js");
  const result = await embed("");
  assert.equal(result, null);
});

test("embeddings: embed returns null for non-string input", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embed } = await import("../lib/embeddings.js");
  const result = await embed(null);
  assert.equal(result, null);
});

test("embeddings: embedBatch returns null when OPENAI_API_KEY not set", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embedBatch } = await import("../lib/embeddings.js");
  const result = await embedBatch(["hello", "world"]);
  assert.equal(result, null);
});

test("embeddings: embedBatch returns empty array for empty input when key set", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-fake-key";
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embedBatch } = await import("../lib/embeddings.js");
  // Empty array with key set should return [] (no API call needed)
  const result = await embedBatch([]);
  assert.deepEqual(result, []);
});

test("embeddings: embedBatch filters out non-string and empty entries", async (t) => {
  const origKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-fake-key";
  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  const { embedBatch } = await import("../lib/embeddings.js");
  // All invalid entries should result in empty array (no API call)
  const result = await embedBatch([null, "", "   ", 123]);
  assert.deepEqual(result, []);
});
