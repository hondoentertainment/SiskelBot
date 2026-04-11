// @ts-check
/**
 * Phase 54.4: 3D asset understanding.
 *
 * Provides text-format 3D asset parsing (OBJ, PLY ASCII, STL ASCII, GLTF JSON),
 * point-cloud and mesh primitive operations, structural analysis (volume, surface
 * area, bounds, connected components, primitive detection), and JSON-backed
 * metadata storage. All parsers and analysis are pure JS with no external deps.
 *
 * @module 3d-assets
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "3d-assets.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    assets: base.assets && typeof base.assets === "object" ? base.assets : {},
  };
}

// ─── Math helpers ───────────────────────────────────────────────────────────

export function dotProduct(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossProduct(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function computeBoundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 3) continue;
    for (let i = 0; i < 3; i++) {
      const v = Number(p[i]);
      if (!Number.isFinite(v)) continue;
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export function computeCenter(points) {
  if (!Array.isArray(points) || points.length === 0) return [0, 0, 0];
  const { min, max } = computeBoundingBox(points);
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

// ─── Format detection ───────────────────────────────────────────────────────

export function detectFormat(filename, content = null) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".gltf")) return "gltf";
  if (name.endsWith(".glb")) return "glb";
  if (name.endsWith(".obj")) return "obj";
  if (name.endsWith(".ply")) return "ply";
  if (name.endsWith(".stl")) return "stl";
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      try {
        const json = JSON.parse(trimmed);
        if (json && (json.asset || json.nodes || json.meshes || json.scenes)) return "gltf";
      } catch (_) {
        // fallthrough
      }
    }
    if (/^ply\s*$/im.test(trimmed.split("\n")[0] || "")) return "ply";
    if (/^solid\b/i.test(trimmed)) return "stl";
    if (/^v\s+[-\d]/m.test(trimmed) || /^f\s+\d/m.test(trimmed)) return "obj";
  }
  return "unknown";
}

// ─── OBJ parser ─────────────────────────────────────────────────────────────

export function parseObj(text) {
  const vertices = [];
  const normals = [];
  const uvs = [];
  const faces = [];
  if (typeof text !== "string") {
    return { vertices, faces, normals, uvs };
  }
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === "v") {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) vertices.push([x, y, z]);
    } else if (tag === "vn") {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) normals.push([x, y, z]);
    } else if (tag === "vt") {
      const u = Number(parts[1]);
      const v = Number(parts[2]);
      if ([u, v].every(Number.isFinite)) uvs.push([u, v]);
    } else if (tag === "f") {
      const indices = [];
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i].split("/")[0];
        const idx = parseInt(token, 10);
        if (!Number.isFinite(idx)) continue;
        // OBJ uses 1-based indices; convert to 0-based.
        indices.push(idx > 0 ? idx - 1 : vertices.length + idx);
      }
      if (indices.length >= 3) {
        // Fan-triangulate N-gons.
        for (let i = 1; i < indices.length - 1; i++) {
          faces.push([indices[0], indices[i], indices[i + 1]]);
        }
      }
    }
  }
  return { vertices, faces, normals, uvs };
}

// ─── PLY parser (ASCII) ─────────────────────────────────────────────────────

export function parsePly(text) {
  const vertices = [];
  const faces = [];
  const properties = [];
  if (typeof text !== "string") return { vertices, faces, properties };
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim().toLowerCase() !== "ply") {
    return { vertices, faces, properties };
  }
  i = 1;
  let format = "ascii";
  let vertexCount = 0;
  let faceCount = 0;
  let currentElement = null;
  const vertexProps = [];
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (!line) continue;
    if (line.startsWith("comment")) continue;
    if (line.startsWith("format")) {
      format = line.split(/\s+/)[1];
      continue;
    }
    if (line.startsWith("element")) {
      const parts = line.split(/\s+/);
      currentElement = parts[1];
      const count = parseInt(parts[2], 10) || 0;
      if (currentElement === "vertex") vertexCount = count;
      else if (currentElement === "face") faceCount = count;
      continue;
    }
    if (line.startsWith("property")) {
      const parts = line.split(/\s+/);
      if (currentElement === "vertex") {
        vertexProps.push(parts[parts.length - 1]);
      }
      properties.push(line);
      continue;
    }
    if (line === "end_header") break;
  }
  if (format !== "ascii") {
    // Binary PLY is not supported in this pure-JS parser.
    return { vertices, faces, properties };
  }
  for (let v = 0; v < vertexCount && i < lines.length; v++, i++) {
    const line = lines[i].trim();
    if (!line) {
      v--;
      continue;
    }
    const parts = line.split(/\s+/).map(Number);
    const xIdx = vertexProps.indexOf("x");
    const yIdx = vertexProps.indexOf("y");
    const zIdx = vertexProps.indexOf("z");
    const x = xIdx >= 0 ? parts[xIdx] : parts[0];
    const y = yIdx >= 0 ? parts[yIdx] : parts[1];
    const z = zIdx >= 0 ? parts[zIdx] : parts[2];
    if ([x, y, z].every(Number.isFinite)) vertices.push([x, y, z]);
  }
  for (let f = 0; f < faceCount && i < lines.length; f++, i++) {
    const line = lines[i].trim();
    if (!line) {
      f--;
      continue;
    }
    const parts = line.split(/\s+/).map(Number);
    const n = parts[0];
    if (!Number.isFinite(n) || n < 3) continue;
    const indices = parts.slice(1, 1 + n);
    for (let j = 1; j < indices.length - 1; j++) {
      faces.push([indices[0], indices[j], indices[j + 1]]);
    }
  }
  return { vertices, faces, properties };
}

// ─── STL parser (ASCII) ─────────────────────────────────────────────────────

export function parseStl(text) {
  const facets = [];
  if (typeof text !== "string") return { facets };
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith("facet normal")) {
      const normalParts = line.split(/\s+/);
      const normal = [
        Number(normalParts[2]),
        Number(normalParts[3]),
        Number(normalParts[4]),
      ];
      const verts = [];
      i++;
      // outer loop
      if (i < lines.length && /^outer\s+loop/i.test(lines[i].trim())) i++;
      while (i < lines.length && /^vertex/i.test(lines[i].trim())) {
        const vParts = lines[i].trim().split(/\s+/);
        verts.push([Number(vParts[1]), Number(vParts[2]), Number(vParts[3])]);
        i++;
      }
      // endloop
      if (i < lines.length && /^endloop/i.test(lines[i].trim())) i++;
      // endfacet
      if (i < lines.length && /^endfacet/i.test(lines[i].trim())) i++;
      if (verts.length >= 3 && normal.every(Number.isFinite)) {
        facets.push({ normal, vertices: verts });
      }
    } else {
      i++;
    }
  }
  return { facets };
}

// ─── GLTF parser (JSON only) ────────────────────────────────────────────────

export function parseGltf(json) {
  let doc = json;
  if (typeof json === "string") {
    try {
      doc = JSON.parse(json);
    } catch (_) {
      doc = {};
    }
  }
  if (!doc || typeof doc !== "object") doc = {};
  const nodes = Array.isArray(doc.nodes) ? doc.nodes.slice() : [];
  const meshes = Array.isArray(doc.meshes) ? doc.meshes.slice() : [];
  const materials = Array.isArray(doc.materials) ? doc.materials.slice() : [];
  const scenes = Array.isArray(doc.scenes) ? doc.scenes.slice() : [];
  return { nodes, meshes, materials, scenes };
}

// ─── Point cloud ────────────────────────────────────────────────────────────

export class PointCloud {
  constructor(points) {
    this.points = Array.isArray(points)
      ? points.filter((p) => Array.isArray(p) && p.length >= 3)
      : [];
  }

  size() {
    return this.points.length;
  }

  getBounds() {
    return computeBoundingBox(this.points);
  }

  getCenter() {
    return computeCenter(this.points);
  }

  downsample(ratio) {
    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0 || r >= 1) {
      return new PointCloud(this.points.slice());
    }
    const step = Math.max(1, Math.round(1 / r));
    const sampled = [];
    for (let i = 0; i < this.points.length; i += step) {
      sampled.push(this.points[i]);
    }
    return new PointCloud(sampled);
  }

  transform(matrix) {
    // Accepts a 4x4 row-major matrix as a flat array of 16 numbers.
    if (!Array.isArray(matrix) || matrix.length !== 16) {
      return new PointCloud(this.points.slice());
    }
    const m = matrix;
    const transformed = this.points.map(([x, y, z]) => {
      const nx = m[0] * x + m[1] * y + m[2] * z + m[3];
      const ny = m[4] * x + m[5] * y + m[6] * z + m[7];
      const nz = m[8] * x + m[9] * y + m[10] * z + m[11];
      return [nx, ny, nz];
    });
    return new PointCloud(transformed);
  }

  toJSON() {
    return {
      type: "PointCloud",
      points: this.points,
      size: this.size(),
      bounds: this.getBounds(),
      center: this.getCenter(),
    };
  }
}

// ─── Mesh ───────────────────────────────────────────────────────────────────

export class Mesh {
  constructor({ vertices, faces, normals, uvs } = {}) {
    this.vertices = Array.isArray(vertices) ? vertices : [];
    this.faces = Array.isArray(faces) ? faces : [];
    this.normals = Array.isArray(normals) ? normals : [];
    this.uvs = Array.isArray(uvs) ? uvs : [];
  }

  getVertexCount() {
    return this.vertices.length;
  }

  getFaceCount() {
    return this.faces.length;
  }

  getBounds() {
    return computeBoundingBox(this.vertices);
  }

  getSurfaceArea() {
    let area = 0;
    for (const face of this.faces) {
      if (!Array.isArray(face) || face.length < 3) continue;
      const a = this.vertices[face[0]];
      const b = this.vertices[face[1]];
      const c = this.vertices[face[2]];
      if (!a || !b || !c) continue;
      const ab = subtract(b, a);
      const ac = subtract(c, a);
      const cross = crossProduct(ab, ac);
      const mag = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
      area += mag / 2;
    }
    return area;
  }

  getVolume() {
    // Signed tetrahedron volume sum relative to the origin. For a closed
    // triangle mesh with consistently oriented outward normals, this equals
    // the enclosed volume.
    let volume = 0;
    for (const face of this.faces) {
      if (!Array.isArray(face) || face.length < 3) continue;
      const a = this.vertices[face[0]];
      const b = this.vertices[face[1]];
      const c = this.vertices[face[2]];
      if (!a || !b || !c) continue;
      const v321 = c[0] * b[1] * a[2];
      const v231 = b[0] * c[1] * a[2];
      const v312 = c[0] * a[1] * b[2];
      const v132 = a[0] * c[1] * b[2];
      const v213 = b[0] * a[1] * c[2];
      const v123 = a[0] * b[1] * c[2];
      volume += (-v321 + v231 + v312 - v132 - v213 + v123) / 6;
    }
    return Math.abs(volume);
  }

  simplify(ratio) {
    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0 || r >= 1) {
      return new Mesh({
        vertices: this.vertices.slice(),
        faces: this.faces.slice(),
        normals: this.normals.slice(),
        uvs: this.uvs.slice(),
      });
    }
    const targetCount = Math.max(1, Math.floor(this.faces.length * r));
    const step = Math.max(1, Math.round(this.faces.length / targetCount));
    const kept = [];
    for (let i = 0; i < this.faces.length; i += step) {
      kept.push(this.faces[i]);
      if (kept.length >= targetCount) break;
    }
    return new Mesh({
      vertices: this.vertices.slice(),
      faces: kept,
      normals: this.normals.slice(),
      uvs: this.uvs.slice(),
    });
  }

  computeNormals() {
    const normals = new Array(this.vertices.length)
      .fill(null)
      .map(() => [0, 0, 0]);
    for (const face of this.faces) {
      if (!Array.isArray(face) || face.length < 3) continue;
      const a = this.vertices[face[0]];
      const b = this.vertices[face[1]];
      const c = this.vertices[face[2]];
      if (!a || !b || !c) continue;
      const ab = subtract(b, a);
      const ac = subtract(c, a);
      const n = crossProduct(ab, ac);
      for (let k = 0; k < 3; k++) {
        const idx = face[k];
        if (idx < 0 || idx >= normals.length) continue;
        normals[idx][0] += n[0];
        normals[idx][1] += n[1];
        normals[idx][2] += n[2];
      }
    }
    this.normals = normals.map(normalize);
    return this.normals;
  }

  toJSON() {
    return {
      type: "Mesh",
      vertices: this.vertices,
      faces: this.faces,
      normals: this.normals,
      uvs: this.uvs,
      vertexCount: this.getVertexCount(),
      faceCount: this.getFaceCount(),
      bounds: this.getBounds(),
    };
  }
}

// ─── Analysis ───────────────────────────────────────────────────────────────

function isManifoldAndWatertight(mesh) {
  // Every edge must be shared by exactly two faces (watertight, manifold).
  const edgeCounts = new Map();
  let manifold = true;
  for (const face of mesh.faces) {
    if (!Array.isArray(face) || face.length < 3) continue;
    for (let k = 0; k < 3; k++) {
      const a = face[k];
      const b = face[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cnt = (edgeCounts.get(key) || 0) + 1;
      edgeCounts.set(key, cnt);
      if (cnt > 2) manifold = false;
    }
  }
  let watertight = mesh.faces.length > 0;
  for (const cnt of edgeCounts.values()) {
    if (cnt !== 2) watertight = false;
  }
  return { manifold, watertight };
}

export function analyzeMesh(mesh) {
  const m = mesh instanceof Mesh ? mesh : new Mesh(mesh || {});
  const { manifold, watertight } = isManifoldAndWatertight(m);
  return {
    faceCount: m.getFaceCount(),
    vertexCount: m.getVertexCount(),
    bounds: m.getBounds(),
    volume: m.getVolume(),
    surfaceArea: m.getSurfaceArea(),
    manifold,
    watertight,
  };
}

export function analyzePointCloud(cloud) {
  const c = cloud instanceof PointCloud ? cloud : new PointCloud(cloud?.points || cloud || []);
  const bounds = c.getBounds();
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const volume = Math.max(dx * dy * dz, 1e-9);
  const density = c.size() / volume;
  // Simple distribution metric: std-dev of coordinates per axis.
  const center = c.getCenter();
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of c.points) {
    sx += (p[0] - center[0]) ** 2;
    sy += (p[1] - center[1]) ** 2;
    sz += (p[2] - center[2]) ** 2;
  }
  const n = Math.max(1, c.size());
  const distribution = {
    stdX: Math.sqrt(sx / n),
    stdY: Math.sqrt(sy / n),
    stdZ: Math.sqrt(sz / n),
  };
  return {
    pointCount: c.size(),
    bounds,
    center,
    density,
    distribution,
  };
}

// ─── Structural features ───────────────────────────────────────────────────

export function detectPrimitives(mesh) {
  const m = mesh instanceof Mesh ? mesh : new Mesh(mesh || {});
  const { min, max } = m.getBounds();
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const dims = [dx, dy, dz];
  const largest = Math.max(...dims);
  const smallest = Math.min(...dims);
  if (largest === 0) {
    return { primitive: "point", confidence: 1, bounds: { min, max } };
  }
  const ratioMaxMin = smallest > 0 ? largest / smallest : Infinity;
  // Box: near-equal extents with relatively few faces.
  const isCubeLike = ratioMaxMin < 1.2;
  const boxVolume = dx * dy * dz;
  const meshVolume = m.getVolume();
  const fillRatio = boxVolume > 0 ? meshVolume / boxVolume : 0;
  if (isCubeLike && m.getFaceCount() >= 6 && m.getFaceCount() <= 64 && fillRatio > 0.8) {
    return {
      primitive: "box",
      confidence: Math.min(1, fillRatio),
      bounds: { min, max },
      dimensions: dims,
    };
  }
  // Sphere: near-equal extents and mesh volume roughly matches sphere volume.
  if (isCubeLike) {
    const r = largest / 2;
    const sphereVol = (4 / 3) * Math.PI * r ** 3;
    if (sphereVol > 0 && meshVolume / sphereVol > 0.75 && meshVolume / sphereVol < 1.25) {
      return {
        primitive: "sphere",
        confidence: 0.9,
        bounds: { min, max },
        radius: r,
      };
    }
  }
  // Cylinder: one axis much shorter or longer than the other two.
  const sortedDims = dims.slice().sort((a, b) => a - b);
  if (sortedDims[1] > 0 && sortedDims[2] / sortedDims[1] < 1.2 && sortedDims[0] / sortedDims[1] < 0.9) {
    return {
      primitive: "cylinder",
      confidence: 0.7,
      bounds: { min, max },
      dimensions: dims,
    };
  }
  return {
    primitive: "unknown",
    confidence: 0.0,
    bounds: { min, max },
    dimensions: dims,
  };
}

export function countConnectedComponents(mesh) {
  const m = mesh instanceof Mesh ? mesh : new Mesh(mesh || {});
  const n = m.faces.length;
  if (n === 0) return 0;

  // Union-find over faces, connecting faces that share an edge.
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const edgeMap = new Map();
  for (let i = 0; i < n; i++) {
    const face = m.faces[i];
    if (!Array.isArray(face) || face.length < 3) continue;
    for (let k = 0; k < 3; k++) {
      const a = face[k];
      const b = face[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (edgeMap.has(key)) {
        union(i, edgeMap.get(key));
      } else {
        edgeMap.set(key, i);
      }
    }
  }

  const roots = new Set();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

// ─── Storage ────────────────────────────────────────────────────────────────

export async function saveAssetMetadata(assetId, metadata) {
  const id = assetId || `asset_${randomUUID()}`;
  const path = storePath();
  return withPathLock(path, async () => {
    const store = normalizeStore(await readJsonPath(path, { _version: STORE_VERSION, assets: {} }));
    const now = Date.now();
    const existing = store.assets[id];
    const record = {
      id,
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    store.assets[id] = record;
    await writeJsonPath(path, store);
    return record;
  });
}

export async function getAssetMetadata(assetId) {
  const path = storePath();
  const store = normalizeStore(await readJsonPath(path, { _version: STORE_VERSION, assets: {} }));
  return store.assets[assetId] || null;
}

export async function listAssets(workspaceId = null) {
  const path = storePath();
  const store = normalizeStore(await readJsonPath(path, { _version: STORE_VERSION, assets: {} }));
  const all = Object.values(store.assets);
  if (workspaceId == null) return all;
  return all.filter((a) => a.workspaceId === workspaceId);
}

export const _internals = {
  storePath,
  normalizeStore,
};
