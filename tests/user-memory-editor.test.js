import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remember, listMemories, updateMemory, forget } from "../lib/agent-memory.js";

test("a user can edit, pin, and forget their own facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const first = await remember("ada", "default", { content: "Lives in Austin", category: "fact", importance: 3 });
    const second = await remember("ada", "default", { content: "Prefers morning meetings", category: "preference", importance: 3 });
    const edited = await updateMemory(first.id, { content: "Lives in Austin, Texas", pinned: true }, "default", "ada");
    assert.equal(edited.ok, true);
    assert.equal(edited.memory.metadata.pinned, true);
    const listed = await listMemories("ada", "default");
    assert.equal(listed.memories[0].id, first.id);
    assert.equal(listed.memories[0].content, "Lives in Austin, Texas");
    const gone = await forget("ada", "default", second.id);
    assert.equal(gone.ok, true);
    const after = await listMemories("ada", "default");
    assert.equal(after.total, 1);
    const other = await listMemories("grace", "default");
    assert.equal(other.total, 0);
  } finally {
    if (prev === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
