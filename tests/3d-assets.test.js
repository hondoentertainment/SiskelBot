/**
 * Phase 54.4: 3D asset understanding tests.
 *
 * Covers format detection, OBJ/PLY/STL/GLTF parsing, point-cloud and mesh
 * operations, analysis (volume, surface area, manifold, components), primitive
 * detection, and JSON-backed asset metadata storage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-3d-assets-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  detectFormat,
  parseObj,
  parsePly,
  parseStl,
  parseGltf,
  PointCloud,
  Mesh,
  analyzeMesh,
  analyzePointCloud,
  detectPrimitives,
  countConnectedComponents,
  saveAssetMetadata,
  getAssetMetadata,
  listAssets,
  computeBoundingBox,
  computeCenter,
  crossProduct,
  dotProduct,
  normalize,
} = await import("../lib/3d-assets.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ─── Unit cube fixtures ─────────────────────────────────────────────────────

function unitCubeMesh() {
  // Unit cube from (0,0,0) to (1,1,1) with outward-facing triangles.
  const vertices = [
    [0, 0, 0], // 0
    [1, 0, 0], // 1
    [1, 1, 0], // 2
    [0, 1, 0], // 3
    [0, 0, 1], // 4
    [1, 0, 1], // 5
    [1, 1, 1], // 6
    [0, 1, 1], // 7
  ];
  const faces = [
    // bottom (z=0), normal -z: wind CW when viewed from +z -> CCW from -z
    [0, 2, 1],
    [0, 3, 2],
    // top (z=1), normal +z
    [4, 5, 6],
    [4, 6, 7],
    // front (y=0), normal -y
    [0, 1, 5],
    [0, 5, 4],
    // back (y=1), normal +y
    [3, 7, 6],
    [3, 6, 2],
    // left (x=0), normal -x
    [0, 4, 7],
    [0, 7, 3],
    // right (x=1), normal +x
    [1, 2, 6],
    [1, 6, 5],
  ];
  return new Mesh({ vertices, faces });
}

// ─── Format detection ───────────────────────────────────────────────────────

test("detectFormat by extension", () => {
  assert.equal(detectFormat("model.gltf"), "gltf");
  assert.equal(detectFormat("model.glb"), "glb");
  assert.equal(detectFormat("model.obj"), "obj");
  assert.equal(detectFormat("model.ply"), "ply");
  assert.equal(detectFormat("model.stl"), "stl");
  assert.equal(detectFormat("model.xyz"), "unknown");
});

test("detectFormat falls back to content sniffing", () => {
  assert.equal(detectFormat("noext", '{"asset":{"version":"2.0"}}'), "gltf");
  assert.equal(detectFormat("noext", "ply\nformat ascii 1.0\n"), "ply");
  assert.equal(detectFormat("noext", "solid cube\nfacet normal 0 0 1\n"), "stl");
  assert.equal(detectFormat("noext", "v 0 0 0\nv 1 0 0\n"), "obj");
});

// ─── OBJ parsing ────────────────────────────────────────────────────────────

test("parseObj parses a cube OBJ with faces and vertices", () => {
  const obj = [
    "# test cube",
    "v 0 0 0",
    "v 1 0 0",
    "v 1 1 0",
    "v 0 1 0",
    "f 1 2 3 4",
  ].join("\n");
  const mesh = parseObj(obj);
  assert.equal(mesh.vertices.length, 4);
  assert.deepEqual(mesh.vertices[0], [0, 0, 0]);
  // f 1 2 3 4 is a quad -> fan-triangulates to 2 triangles.
  assert.equal(mesh.faces.length, 2);
  assert.deepEqual(mesh.faces[0], [0, 1, 2]);
  assert.deepEqual(mesh.faces[1], [0, 2, 3]);
});

test("parseObj handles f tokens with slashes (v/vt/vn)", () => {
  const obj = [
    "v 0 0 0",
    "v 1 0 0",
    "v 0 1 0",
    "vn 0 0 1",
    "vt 0 0",
    "f 1/1/1 2/1/1 3/1/1",
  ].join("\n");
  const mesh = parseObj(obj);
  assert.equal(mesh.vertices.length, 3);
  assert.equal(mesh.normals.length, 1);
  assert.equal(mesh.uvs.length, 1);
  assert.equal(mesh.faces.length, 1);
});

test("parseObj handles invalid input without throwing", () => {
  const mesh = parseObj("garbage input\nnot an obj");
  assert.deepEqual(mesh.vertices, []);
  assert.deepEqual(mesh.faces, []);
  const empty = parseObj("");
  assert.deepEqual(empty.vertices, []);
  const notString = parseObj(null);
  assert.deepEqual(notString.vertices, []);
});

// ─── PLY parsing ────────────────────────────────────────────────────────────

test("parsePly parses a minimal ASCII PLY", () => {
  const ply = [
    "ply",
    "format ascii 1.0",
    "comment test",
    "element vertex 3",
    "property float x",
    "property float y",
    "property float z",
    "element face 1",
    "property list uchar int vertex_indices",
    "end_header",
    "0 0 0",
    "1 0 0",
    "0 1 0",
    "3 0 1 2",
  ].join("\n");
  const mesh = parsePly(ply);
  assert.equal(mesh.vertices.length, 3);
  assert.deepEqual(mesh.vertices[0], [0, 0, 0]);
  assert.equal(mesh.faces.length, 1);
  assert.deepEqual(mesh.faces[0], [0, 1, 2]);
});

// ─── STL parsing ────────────────────────────────────────────────────────────

test("parseStl parses an ASCII STL triangle", () => {
  const stl = [
    "solid simple",
    "facet normal 0 0 1",
    "  outer loop",
    "    vertex 0 0 0",
    "    vertex 1 0 0",
    "    vertex 0 1 0",
    "  endloop",
    "endfacet",
    "endsolid simple",
  ].join("\n");
  const result = parseStl(stl);
  assert.equal(result.facets.length, 1);
  assert.deepEqual(result.facets[0].normal, [0, 0, 1]);
  assert.equal(result.facets[0].vertices.length, 3);
});

// ─── GLTF parsing ───────────────────────────────────────────────────────────

test("parseGltf extracts nodes, meshes, materials, scenes", () => {
  const json = {
    asset: { version: "2.0" },
    nodes: [{ name: "root" }, { name: "child" }],
    meshes: [{ primitives: [] }],
    materials: [{ name: "m1" }],
    scenes: [{ nodes: [0] }],
  };
  const out = parseGltf(json);
  assert.equal(out.nodes.length, 2);
  assert.equal(out.meshes.length, 1);
  assert.equal(out.materials.length, 1);
  assert.equal(out.scenes.length, 1);
  // Accepts JSON string as well.
  const out2 = parseGltf(JSON.stringify(json));
  assert.equal(out2.nodes.length, 2);
});

// ─── PointCloud ─────────────────────────────────────────────────────────────

test("PointCloud bounds and center for an axis-aligned box", () => {
  const pc = new PointCloud([
    [0, 0, 0],
    [2, 0, 0],
    [0, 4, 0],
    [0, 0, 6],
  ]);
  assert.equal(pc.size(), 4);
  const bounds = pc.getBounds();
  assert.deepEqual(bounds.min, [0, 0, 0]);
  assert.deepEqual(bounds.max, [2, 4, 6]);
  assert.deepEqual(pc.getCenter(), [1, 2, 3]);
});

test("PointCloud downsample reduces size", () => {
  const points = [];
  for (let i = 0; i < 100; i++) points.push([i, 0, 0]);
  const pc = new PointCloud(points);
  const half = pc.downsample(0.5);
  assert.ok(half.size() < pc.size());
  assert.ok(half.size() >= 40 && half.size() <= 60);
  const quarter = pc.downsample(0.25);
  assert.ok(quarter.size() < half.size());
});

test("PointCloud transform applies a 4x4 translation", () => {
  const pc = new PointCloud([
    [0, 0, 0],
    [1, 0, 0],
  ]);
  // prettier-ignore
  const translate = [
    1, 0, 0, 10,
    0, 1, 0, 20,
    0, 0, 1, 30,
    0, 0, 0, 1,
  ];
  const moved = pc.transform(translate);
  assert.deepEqual(moved.points[0], [10, 20, 30]);
  assert.deepEqual(moved.points[1], [11, 20, 30]);
});

// ─── Mesh ───────────────────────────────────────────────────────────────────

test("Mesh vertex/face count", () => {
  const m = unitCubeMesh();
  assert.equal(m.getVertexCount(), 8);
  assert.equal(m.getFaceCount(), 12);
});

test("Mesh bounds", () => {
  const m = unitCubeMesh();
  const b = m.getBounds();
  assert.deepEqual(b.min, [0, 0, 0]);
  assert.deepEqual(b.max, [1, 1, 1]);
});

test("Mesh getVolume for unit cube", () => {
  const m = unitCubeMesh();
  const v = m.getVolume();
  assert.ok(Math.abs(v - 1) < 1e-9, `expected 1, got ${v}`);
});

test("Mesh getSurfaceArea for unit cube", () => {
  const m = unitCubeMesh();
  const a = m.getSurfaceArea();
  assert.ok(Math.abs(a - 6) < 1e-9, `expected 6, got ${a}`);
});

test("Mesh computeNormals produces unit vectors", () => {
  const m = unitCubeMesh();
  m.computeNormals();
  assert.equal(m.normals.length, 8);
  for (const n of m.normals) {
    const len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
    assert.ok(Math.abs(len - 1) < 1e-9 || len === 0);
  }
});

test("Mesh simplify reduces face count", () => {
  const m = unitCubeMesh();
  const s = m.simplify(0.5);
  assert.ok(s.getFaceCount() < m.getFaceCount());
  assert.ok(s.getFaceCount() >= 1);
});

test("Empty mesh is handled safely", () => {
  const m = new Mesh({});
  assert.equal(m.getVertexCount(), 0);
  assert.equal(m.getFaceCount(), 0);
  assert.equal(m.getVolume(), 0);
  assert.equal(m.getSurfaceArea(), 0);
  const bounds = m.getBounds();
  assert.deepEqual(bounds.min, [0, 0, 0]);
});

// ─── Analysis ───────────────────────────────────────────────────────────────

test("analyzeMesh returns complete structure for unit cube", () => {
  const m = unitCubeMesh();
  const a = analyzeMesh(m);
  assert.equal(a.faceCount, 12);
  assert.equal(a.vertexCount, 8);
  assert.ok(Math.abs(a.volume - 1) < 1e-9);
  assert.ok(Math.abs(a.surfaceArea - 6) < 1e-9);
  assert.equal(a.manifold, true);
  assert.equal(a.watertight, true);
});

test("analyzePointCloud returns pointCount, bounds, density", () => {
  const pc = new PointCloud([
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
  ]);
  const a = analyzePointCloud(pc);
  assert.equal(a.pointCount, 5);
  assert.deepEqual(a.bounds.min, [0, 0, 0]);
  assert.deepEqual(a.bounds.max, [1, 1, 1]);
  assert.ok(a.density > 0);
  assert.ok("stdX" in a.distribution);
});

// ─── Primitives and components ──────────────────────────────────────────────

test("detectPrimitives identifies a unit cube as box", () => {
  const m = unitCubeMesh();
  const p = detectPrimitives(m);
  assert.equal(p.primitive, "box");
  assert.ok(p.confidence > 0);
});

test("countConnectedComponents for unit cube equals 1", () => {
  const m = unitCubeMesh();
  assert.equal(countConnectedComponents(m), 1);
});

test("countConnectedComponents for two disjoint triangles equals 2", () => {
  const mesh = new Mesh({
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [10, 10, 10],
      [11, 10, 10],
      [10, 11, 10],
    ],
    faces: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  });
  assert.equal(countConnectedComponents(mesh), 2);
});

// ─── Storage ────────────────────────────────────────────────────────────────

test("saveAssetMetadata + getAssetMetadata roundtrip", async () => {
  const record = await saveAssetMetadata("asset-a", {
    name: "cube",
    format: "obj",
    workspaceId: "ws-1",
    stats: { faceCount: 12, vertexCount: 8 },
  });
  assert.equal(record.id, "asset-a");
  assert.equal(record.name, "cube");
  const fetched = await getAssetMetadata("asset-a");
  assert.ok(fetched);
  assert.equal(fetched.format, "obj");
  assert.equal(fetched.stats.faceCount, 12);
  assert.ok(fetched.createdAt > 0);
});

test("listAssets filters by workspaceId", async () => {
  await saveAssetMetadata("asset-b", { name: "b", workspaceId: "ws-1" });
  await saveAssetMetadata("asset-c", { name: "c", workspaceId: "ws-2" });
  const ws1 = await listAssets("ws-1");
  const ids1 = ws1.map((a) => a.id).sort();
  assert.ok(ids1.includes("asset-a"));
  assert.ok(ids1.includes("asset-b"));
  const ws2 = await listAssets("ws-2");
  assert.equal(ws2.length, 1);
  assert.equal(ws2[0].id, "asset-c");
  const all = await listAssets();
  assert.ok(all.length >= 3);
});

// ─── Math helpers ───────────────────────────────────────────────────────────

test("math helpers: cross, dot, normalize, bounds, center", () => {
  assert.deepEqual(crossProduct([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  const n = normalize([3, 0, 0]);
  assert.deepEqual(n, [1, 0, 0]);
  const b = computeBoundingBox([
    [-1, -1, -1],
    [2, 3, 4],
  ]);
  assert.deepEqual(b.min, [-1, -1, -1]);
  assert.deepEqual(b.max, [2, 3, 4]);
  const c = computeCenter([
    [0, 0, 0],
    [2, 2, 2],
  ]);
  assert.deepEqual(c, [1, 1, 1]);
});
