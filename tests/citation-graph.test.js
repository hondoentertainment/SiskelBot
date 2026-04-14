/**
 * Phase 64.3: Citation graph tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-citation-graph-"));
process.env.STORAGE_PATH = TMP;

const {
  addPaper,
  addCitation,
  getNeighbors,
  getSubgraph,
  findShortestPath,
  listPapers,
  getCitationCount,
  VALID_DIRECTIONS,
  _reset,
} = await import("../lib/citation-graph.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("VALID_DIRECTIONS contains in/out/both", () => {
  for (const d of ["in", "out", "both"]) {
    assert.ok(VALID_DIRECTIONS.includes(d));
  }
});

test("addPaper creates a paper and listPapers returns it", async () => {
  await _reset("ws-a");
  const rec = await addPaper({ workspaceId: "ws-a", paperId: "arxiv:2301.00001", metadata: { title: "A" } });
  assert.equal(rec.id, "arxiv:2301.00001");
  assert.equal(rec.metadata.title, "A");
  const list = await listPapers("ws-a");
  assert.equal(list.length, 1);
});

test("addPaper requires paperId", async () => {
  await assert.rejects(() => addPaper({ workspaceId: "ws" }), /paperId is required/);
});

test("addCitation requires both ids and rejects self-cite", async () => {
  await _reset("ws-c");
  await assert.rejects(() => addCitation({ workspaceId: "ws-c", citedId: "b" }), /citerId is required/);
  await assert.rejects(() => addCitation({ workspaceId: "ws-c", citerId: "a" }), /citedId is required/);
  await assert.rejects(() => addCitation({ workspaceId: "ws-c", citerId: "a", citedId: "a" }), /must differ/);
});

test("addCitation auto-creates missing papers and connects them", async () => {
  await _reset("ws-auto");
  const res = await addCitation({ workspaceId: "ws-auto", citerId: "p1", citedId: "p2" });
  assert.equal(res.created, true);
  const list = await listPapers("ws-auto");
  const ids = list.map((p) => p.id).sort();
  assert.deepEqual(ids, ["p1", "p2"]);
});

test("getNeighbors returns outgoing, incoming, and combined", async () => {
  await _reset("ws-n");
  await addCitation({ workspaceId: "ws-n", citerId: "a", citedId: "b" });
  await addCitation({ workspaceId: "ws-n", citerId: "a", citedId: "c" });
  await addCitation({ workspaceId: "ws-n", citerId: "d", citedId: "a" });

  const out = await getNeighbors({ workspaceId: "ws-n", paperId: "a", direction: "out" });
  assert.deepEqual(out.map((p) => p.id).sort(), ["b", "c"]);

  const inn = await getNeighbors({ workspaceId: "ws-n", paperId: "a", direction: "in" });
  assert.deepEqual(inn.map((p) => p.id), ["d"]);

  const both = await getNeighbors({ workspaceId: "ws-n", paperId: "a", direction: "both" });
  assert.deepEqual(both.map((p) => p.id).sort(), ["b", "c", "d"]);
});

test("getSubgraph expands to the given depth", async () => {
  await _reset("ws-s");
  await addCitation({ workspaceId: "ws-s", citerId: "a", citedId: "b" });
  await addCitation({ workspaceId: "ws-s", citerId: "b", citedId: "c" });
  await addCitation({ workspaceId: "ws-s", citerId: "c", citedId: "d" });

  const d1 = await getSubgraph({ workspaceId: "ws-s", paperId: "a", depth: 1 });
  const d1Ids = d1.nodes.map((n) => n.id).sort();
  assert.deepEqual(d1Ids, ["a", "b"]);

  const d2 = await getSubgraph({ workspaceId: "ws-s", paperId: "a", depth: 2 });
  const d2Ids = d2.nodes.map((n) => n.id).sort();
  assert.deepEqual(d2Ids, ["a", "b", "c"]);

  const d3 = await getSubgraph({ workspaceId: "ws-s", paperId: "a", depth: 3 });
  const d3Ids = d3.nodes.map((n) => n.id).sort();
  assert.deepEqual(d3Ids, ["a", "b", "c", "d"]);

  // edges should include a->b, b->c
  assert.ok(d2.edges.some((e) => e.from === "a" && e.to === "b"));
  assert.ok(d2.edges.some((e) => e.from === "b" && e.to === "c"));
});

test("getSubgraph returns empty when paper is missing", async () => {
  await _reset("ws-empty");
  const g = await getSubgraph({ workspaceId: "ws-empty", paperId: "nonexistent", depth: 2 });
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
});

test("findShortestPath returns BFS path treating edges as undirected", async () => {
  await _reset("ws-p");
  // a -> b -> c, d -> c (so path a..d passes through c)
  await addCitation({ workspaceId: "ws-p", citerId: "a", citedId: "b" });
  await addCitation({ workspaceId: "ws-p", citerId: "b", citedId: "c" });
  await addCitation({ workspaceId: "ws-p", citerId: "d", citedId: "c" });

  const path = await findShortestPath({ workspaceId: "ws-p", fromId: "a", toId: "d" });
  assert.ok(Array.isArray(path));
  assert.equal(path[0], "a");
  assert.equal(path[path.length - 1], "d");
  assert.equal(path.length, 4); // a-b-c-d
});

test("findShortestPath handles self and missing nodes", async () => {
  await _reset("ws-p2");
  await addPaper({ workspaceId: "ws-p2", paperId: "x" });
  const self = await findShortestPath({ workspaceId: "ws-p2", fromId: "x", toId: "x" });
  assert.deepEqual(self, ["x"]);

  const missing = await findShortestPath({ workspaceId: "ws-p2", fromId: "x", toId: "y" });
  assert.equal(missing, null);
});

test("findShortestPath returns null when disconnected", async () => {
  await _reset("ws-d");
  await addCitation({ workspaceId: "ws-d", citerId: "a", citedId: "b" });
  await addCitation({ workspaceId: "ws-d", citerId: "c", citedId: "d" });
  const path = await findShortestPath({ workspaceId: "ws-d", fromId: "a", toId: "d" });
  assert.equal(path, null);
});

test("getCitationCount returns cites and citedBy counts", async () => {
  await _reset("ws-count");
  await addCitation({ workspaceId: "ws-count", citerId: "a", citedId: "b" });
  await addCitation({ workspaceId: "ws-count", citerId: "a", citedId: "c" });
  await addCitation({ workspaceId: "ws-count", citerId: "d", citedId: "a" });
  await addCitation({ workspaceId: "ws-count", citerId: "e", citedId: "a" });

  const a = await getCitationCount({ workspaceId: "ws-count", paperId: "a" });
  assert.equal(a.cites, 2);
  assert.equal(a.citedBy, 2);
});

test("duplicate citations do not double-count", async () => {
  await _reset("ws-dup");
  const r1 = await addCitation({ workspaceId: "ws-dup", citerId: "a", citedId: "b" });
  assert.equal(r1.created, true);
  const r2 = await addCitation({ workspaceId: "ws-dup", citerId: "a", citedId: "b" });
  assert.equal(r2.created, false);
  const count = await getCitationCount({ workspaceId: "ws-dup", paperId: "b" });
  assert.equal(count.citedBy, 1);
});
