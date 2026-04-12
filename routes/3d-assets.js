/**
 * Phase 54.4: 3D asset understanding routes.
 *
 * POST /api/v1/3d/parse                 — parse an OBJ/PLY/STL/GLTF asset
 * POST /api/v1/3d/analyze/mesh          — mesh analysis (volume, surface area, manifold, watertight)
 * POST /api/v1/3d/analyze/pointcloud    — point cloud analysis (bounds, center, density, distribution)
 * POST /api/v1/3d/detect-format         — detect asset format from filename / content
 * POST /api/v1/3d/primitives            — primitive detection (box, sphere, cylinder)
 * POST /api/v1/3d/assets                — save asset metadata
 * GET  /api/v1/3d/assets                — list assets (optional workspaceId filter)
 * GET  /api/v1/3d/assets/:id            — fetch asset metadata by id
 */
import {
  detectFormat,
  parseObj,
  parsePly,
  parseStl,
  parseGltf,
  Mesh,
  PointCloud,
  analyzeMesh,
  analyzePointCloud,
  detectPrimitives,
  countConnectedComponents,
  saveAssetMetadata,
  getAssetMetadata,
  listAssets,
} from "../lib/3d-assets.js";

function parseByFormat(format, content) {
  switch (String(format || "").toLowerCase()) {
    case "obj":
      return { format: "obj", mesh: parseObj(content) };
    case "ply":
      return { format: "ply", mesh: parsePly(content) };
    case "stl":
      return { format: "stl", stl: parseStl(content) };
    case "gltf":
    case "glb":
      return { format: "gltf", gltf: parseGltf(content) };
    default:
      return null;
  }
}

export function mount3dAssetsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/3d/parse
  apiRoute("post", "/3d/parse", log, auth, scope("write"), (req, res) => {
    try {
      const { format, content } = req.body || {};
      if (!format) return apiError(res, 400, "INVALID_INPUT", "format is required");
      if (content == null) return apiError(res, 400, "INVALID_INPUT", "content is required");
      const parsed = parseByFormat(format, content);
      if (!parsed) return apiError(res, 400, "INVALID_INPUT", `unsupported format: ${format}`);
      return res.json({ _version: 1, ...parsed });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "parse failed");
    }
  });

  // POST /api/v1/3d/analyze/mesh
  apiRoute("post", "/3d/analyze/mesh", log, auth, scope("write"), (req, res) => {
    try {
      const { mesh } = req.body || {};
      if (!mesh || typeof mesh !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "mesh is required");
      }
      const m = new Mesh(mesh);
      const analysis = analyzeMesh(m);
      const components = countConnectedComponents(m);
      return res.json({ _version: 1, analysis: { ...analysis, connectedComponents: components } });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "mesh analysis failed");
    }
  });

  // POST /api/v1/3d/analyze/pointcloud
  apiRoute("post", "/3d/analyze/pointcloud", log, auth, scope("write"), (req, res) => {
    try {
      const { cloud } = req.body || {};
      if (!cloud) return apiError(res, 400, "INVALID_INPUT", "cloud is required");
      const points = Array.isArray(cloud) ? cloud : cloud.points;
      if (!Array.isArray(points)) {
        return apiError(res, 400, "INVALID_INPUT", "cloud.points must be an array");
      }
      const pc = new PointCloud(points);
      const analysis = analyzePointCloud(pc);
      return res.json({ _version: 1, analysis });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "pointcloud analysis failed");
    }
  });

  // POST /api/v1/3d/detect-format
  apiRoute("post", "/3d/detect-format", log, auth, scope("read"), (req, res) => {
    try {
      const { filename, content } = req.body || {};
      if (!filename && !content) {
        return apiError(res, 400, "INVALID_INPUT", "filename or content is required");
      }
      const format = detectFormat(filename || "", content || null);
      return res.json({ _version: 1, format });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "detect-format failed");
    }
  });

  // POST /api/v1/3d/primitives
  apiRoute("post", "/3d/primitives", log, auth, scope("write"), (req, res) => {
    try {
      const { mesh } = req.body || {};
      if (!mesh || typeof mesh !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "mesh is required");
      }
      const primitive = detectPrimitives(new Mesh(mesh));
      return res.json({ _version: 1, primitive });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "primitive detection failed");
    }
  });

  // POST /api/v1/3d/assets
  apiRoute("post", "/3d/assets", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const id = body.id || null;
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : body;
      const record = await saveAssetMetadata(id, metadata);
      return res.status(201).json({ _version: 1, asset: record });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "save asset failed");
    }
  });

  // GET /api/v1/3d/assets
  apiRoute("get", "/3d/assets", log, auth, scope("read"), async (req, res) => {
    try {
      const workspaceId = req.query.workspaceId ? String(req.query.workspaceId) : null;
      const assets = await listAssets(workspaceId);
      return res.json({ _version: 1, assets, count: assets.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list assets failed");
    }
  });

  // GET /api/v1/3d/assets/:id
  apiRoute("get", "/3d/assets/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const asset = await getAssetMetadata(req.params.id);
      if (!asset) {
        return apiError(res, 404, "NOT_FOUND", `asset ${req.params.id} not found`);
      }
      return res.json({ _version: 1, asset });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "get asset failed");
    }
  });
}

export default mount3dAssetsRoutes;
