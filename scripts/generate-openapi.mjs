#!/usr/bin/env node

/**
 * Auto-generate an OpenAPI 3.0.3 spec from route definitions.
 *
 * Reads all route files in routes/*.js, parses route registrations
 * (app.get, app.post, router.get, apiRoute, etc.) using regex,
 * extracts HTTP method, path, middleware chain, and generates
 * an OpenAPI spec. Merges with hand-written overrides from
 * lib/openapi-overrides.js if present.
 *
 * Usage:
 *   node scripts/generate-openapi.mjs
 *
 * Output:
 *   lib/openapi-generated.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version || "0.1.0";

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

/**
 * Extract route registrations from a source file.
 * Matches patterns like:
 *   app.get("/path", ...middleware, handler)
 *   app.post("/path", ...middleware, handler)
 *   apiRoute("get", "/path", ...middleware, handler)
 */
function extractRoutes(source, fileName) {
  const routes = [];
  const tag = basename(fileName, ".js");

  // Pattern 1: app.METHOD("/path", ...middlewares, handler)
  const appPattern = /app\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]\s*,([^)]*(?:\([^)]*\))*[^;]*?(?=\)\s*;|\)\s*$|\basync\b))/gm;

  // Pattern 2: apiRoute("method", "/path", ...middlewares, handler)
  const apiRoutePattern = /apiRoute\(\s*["'`](get|post|put|delete|patch)["'`]\s*,\s*["'`]([^"'`]+)["'`]\s*,([^;]*?)(?=async\s+\(|(?:\(req|function))/gm;

  function extractMiddleware(middlewareStr) {
    const mw = [];
    const cleaned = middlewareStr.replace(/\s+/g, " ").trim();
    // Look for known middleware names
    const knownMiddleware = [
      "chatAuth", "userAuth", "apiKeyAuth", "adminAuth", "adminAuthOrQuery",
      "internalAuth", "metricsAuth",
      "requireScope", "logRequest",
      "perKeyChatRateLimiter", "chatRateLimiter", "taskPlanRateLimiter",
      "storageRateLimiter", "embeddingsRateLimiter", "knowledgeIndexRateLimiter",
      "integrationRateLimiter", "monitoringRateLimiter", "usageSummaryRateLimiter",
      "analyticsRateLimiter", "adminRateLimiter", "adminIpAllowlist",
      "requireGitHubToken", "requireVercelToken",
    ];
    for (const name of knownMiddleware) {
      if (cleaned.includes(name)) {
        mw.push(name);
      }
    }
    // Extract requireScope argument
    const scopeMatch = cleaned.match(/requireScope\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (scopeMatch) {
      mw.push(`scope:${scopeMatch[1]}`);
    }
    return mw;
  }

  let match;

  // Parse app.METHOD patterns
  while ((match = appPattern.exec(source)) !== null) {
    const method = match[1].toLowerCase();
    const path = match[2];
    const middlewareStr = match[3];
    routes.push({
      method,
      path,
      middleware: extractMiddleware(middlewareStr),
      tag,
      source: fileName,
    });
  }

  // Parse apiRoute patterns
  while ((match = apiRoutePattern.exec(source)) !== null) {
    const method = match[1].toLowerCase();
    const rawPath = match[2];
    const middlewareStr = match[3];
    routes.push({
      method,
      // apiRoute registers at /api/v1{path} and /api{path}
      path: `/api/v1${rawPath}`,
      rawPath,
      isDualRegistered: true,
      middleware: extractMiddleware(middlewareStr),
      tag,
      source: fileName,
    });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// OpenAPI generation helpers
// ---------------------------------------------------------------------------

/** Convert a route path to an operationId: "post /v1/chat/completions" -> "postV1ChatCompletions" */
function toOperationId(method, path) {
  const segments = path
    .replace(/[{}]/g, "")
    .split(/[/:\-_]+/)
    .filter(Boolean);
  const camel = segments.map((s, i) => {
    if (i === 0) return s.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }).join("");
  return `${method}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** Derive tag from route file name */
function deriveTag(fileName) {
  const tag = basename(fileName, ".js");
  const tagMap = {
    auth: "auth",
    chat: "chat",
    tasks: "tasks",
    health: "health",
    integrations: "integrations",
    usage: "usage",
    knowledge: "knowledge",
    workspaces: "workspaces",
    recipes: "recipes",
    teams: "teams",
    admin: "admin",
    docs: "docs",
  };
  return tagMap[tag] || tag;
}

/** Infer security requirements from middleware list */
function inferSecurity(middleware) {
  if (middleware.includes("adminAuth") || middleware.includes("adminAuthOrQuery")) {
    return [{ apiKey: [] }];
  }
  if (middleware.includes("chatAuth") || middleware.includes("apiKeyAuth") || middleware.includes("userAuth")) {
    return [{ bearerAuth: [] }];
  }
  if (middleware.includes("internalAuth")) {
    return [{ apiKey: [] }];
  }
  return [];
}

/** Check if route has a rate limiter */
function hasRateLimiter(middleware) {
  return middleware.some((m) =>
    m.includes("RateLimiter") || m.includes("rateLimiter")
  );
}

/** Extract path parameters from Express-style path */
function extractPathParams(path) {
  const params = [];
  const paramPattern = /:(\w+)/g;
  let m;
  while ((m = paramPattern.exec(path)) !== null) {
    params.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

/** Convert Express path params to OpenAPI style: /repos/:owner/:repo -> /repos/{owner}/{repo} */
function toOpenApiPath(path) {
  return path.replace(/:(\w+)/g, "{$1}");
}

/** Build default responses for a route */
function buildResponses(method, middleware) {
  const responses = {};

  if (method === "post") {
    responses["201"] = { description: "Created" };
  } else if (method === "delete") {
    responses["204"] = { description: "No content" };
  }
  responses["200"] = { description: "Success" };

  const security = inferSecurity(middleware);
  if (security.length > 0) {
    responses["401"] = { description: "Unauthorized" };
    responses["403"] = { description: "Forbidden" };
  }

  if (hasRateLimiter(middleware)) {
    responses["429"] = { description: "Rate limit exceeded" };
  }

  responses["500"] = { description: "Internal server error" };

  return responses;
}

/** Determine if a route should be included (skip static file serving, HTML pages, OAuth callbacks) */
function shouldIncludeRoute(route) {
  const { path } = route;
  // Skip HTML pages
  if (path === "/admin" || path === "/eval" || path === "/marketplace" || path === "/docs") return false;
  // Skip OAuth callback routes
  if (path.includes("/auth/github/callback") || path.includes("/auth/google/callback")) return false;
  // Skip OAuth initiation (browser redirect, not API)
  if (path === "/auth/github" || path === "/auth/google") return false;
  // Skip static file paths
  if (path.includes(".html") || path.includes(".js") || path.includes(".css")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

function generate() {
  const routesDir = join(ROOT, "routes");
  const routeFiles = readdirSync(routesDir)
    .filter((f) => f.endsWith(".js") && f !== "index.js")
    .sort();

  const allRoutes = [];

  for (const file of routeFiles) {
    const filePath = join(routesDir, file);
    const source = readFileSync(filePath, "utf8");
    const routes = extractRoutes(source, file);
    allRoutes.push(...routes);
  }

  // De-duplicate: prefer /api/v1/ routes, skip /api/ legacy duplicates
  const seen = new Set();
  const uniqueRoutes = allRoutes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build OpenAPI paths
  const paths = {};

  for (const route of uniqueRoutes) {
    if (!shouldIncludeRoute(route)) continue;

    const openApiPath = toOpenApiPath(route.path);
    const operationId = toOperationId(route.method, route.path);
    const tag = deriveTag(route.source);
    const security = inferSecurity(route.middleware);
    const pathParams = extractPathParams(route.path);
    const responses = buildResponses(route.method, route.middleware);

    if (!paths[openApiPath]) paths[openApiPath] = {};

    const operation = {
      operationId,
      tags: [tag],
      summary: `${route.method.toUpperCase()} ${route.path}`,
      responses,
    };

    if (security.length > 0) {
      operation.security = security;
    }

    if (pathParams.length > 0) {
      operation.parameters = pathParams;
    }

    if (route.method === "post" || route.method === "put" || route.method === "patch") {
      operation.requestBody = {
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      };
    }

    paths[openApiPath][route.method] = operation;
  }

  // Sort paths alphabetically
  const sortedPaths = {};
  for (const key of Object.keys(paths).sort()) {
    sortedPaths[key] = paths[key];
  }

  const spec = {
    openapi: "3.0.3",
    info: {
      title: "SiskelBot API",
      version: VERSION,
      description:
        "SiskelBot streaming assistant API. Stable endpoints are under /api/v1/. " +
        "Chat completions follow the OpenAI spec at /v1/chat/completions.\n\n" +
        "**Deprecation policy:** Legacy routes under `/api/*` (without `v1`) remain available " +
        "for backward compatibility and respond with `X-API-Deprecated: use /api/v1/`. New integrations " +
        "should call `/api/v1/` only.",
    },
    servers: [{ url: "http://localhost:3000" }],
    paths: sortedPaths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
          description:
            "User API key or deployment API key. Use Authorization: Bearer <key> or x-user-api-key header.",
        },
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "x-admin-api-key",
          description:
            "Admin API key. Pass via x-admin-api-key header or Authorization: Bearer <ADMIN_API_KEY>.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
            hint: { type: "string" },
          },
        },
      },
    },
  };

  // Merge overrides
  const overridesPath = join(ROOT, "lib", "openapi-overrides.js");
  if (existsSync(overridesPath)) {
    console.log("Merging overrides from lib/openapi-overrides.js ...");
    // Dynamic import for ES module
    return import(overridesPath).then((mod) => {
      const overrides = mod.default || mod;
      mergeOverrides(spec, overrides);
      return spec;
    });
  }

  return Promise.resolve(spec);
}

/**
 * Deep-merge override paths into the spec.
 * Overrides keyed by path (e.g. "/v1/chat/completions") are matched against
 * the generated spec paths. The override values are merged at the operation level.
 */
function mergeOverrides(spec, overrides) {
  if (!overrides || typeof overrides !== "object") return;

  for (const [overridePath, methods] of Object.entries(overrides)) {
    // Try to find matching path in spec — check both the override path directly
    // and common prefixed variants
    const candidates = [
      overridePath,
      `/api/v1${overridePath}`,
      overridePath.replace(/^\/api\/v1/, ""),
    ];

    let matchedPath = null;
    for (const candidate of candidates) {
      const openApiCandidate = toOpenApiPath(candidate);
      if (spec.paths[openApiCandidate]) {
        matchedPath = openApiCandidate;
        break;
      }
    }

    if (!matchedPath) {
      // Path not found in generated spec — add it directly
      const openApiPath = toOpenApiPath(overridePath);
      spec.paths[openApiPath] = {};
      matchedPath = openApiPath;
    }

    for (const [method, operationOverride] of Object.entries(methods)) {
      if (!spec.paths[matchedPath][method]) {
        spec.paths[matchedPath][method] = {};
      }
      deepMerge(spec.paths[matchedPath][method], operationOverride);
    }
  }
}

/** Simple deep merge: source values override target */
function deepMerge(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === "object" && !Array.isArray(val) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

generate().then((spec) => {
  const outPath = join(ROOT, "lib", "openapi-generated.js");
  const content = `// Auto-generated by scripts/generate-openapi.mjs — do not edit by hand.\n// Re-run: npm run openapi:generate\n\nconst spec = ${JSON.stringify(spec, null, 2)};\n\nexport default spec;\n`;
  writeFileSync(outPath, content, "utf8");
  const pathCount = Object.keys(spec.paths).length;
  const opCount = Object.values(spec.paths).reduce(
    (sum, methods) => sum + Object.keys(methods).length,
    0
  );
  console.log(`Generated OpenAPI spec: ${pathCount} paths, ${opCount} operations`);
  console.log(`Written to ${outPath}`);
}).catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
