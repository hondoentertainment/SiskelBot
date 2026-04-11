/**
 * Phase 52.1: Tree-of-Thought reasoning routes.
 *
 * POST /api/v1/reasoning/tot/search   — body: { task, depth, beamWidth, k, generator, strategy }
 *                                        strategy: "beam" (default) | "dfs" | "bfs"
 *                                        generator: optional string template; server uses a
 *                                        deterministic mock if no chat completer is wired.
 * POST /api/v1/reasoning/tot/expand   — body: { node, options }
 *                                        node: { thought, depth?, state? }
 * POST /api/v1/reasoning/tot/score    — body: { node }
 * GET  /api/v1/reasoning/tot/tree/:id — retrieve a previously saved tree (JSON)
 */
import { randomUUID } from "crypto";
import { join } from "path";
import {
  ThoughtNode,
  beamSearch,
  dfsSearch,
  bfsSearch,
  expandThought,
  scoreThought,
  extractAnswer,
  treeToDot,
  treeToJson,
} from "../lib/tree-of-thought.js";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "../lib/json-path-store.js";

function storePath() {
  return join(getDataDir(), "tree-of-thought.json");
}

async function loadStore() {
  return readJsonPath(storePath(), { trees: {} });
}

async function saveTree(id, record) {
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.trees = store.trees || {};
    store.trees[id] = record;
    // Soft cap: keep last 200 trees to avoid unbounded growth.
    const ids = Object.keys(store.trees);
    if (ids.length > 200) {
      const sorted = ids
        .map((k) => [k, store.trees[k]?.savedAt || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([k]) => k);
      const next = {};
      for (const k of sorted) next[k] = store.trees[k];
      store.trees = next;
    }
    await writeJsonPath(storePath(), store);
  });
}

async function getTree(id) {
  const store = await loadStore();
  return store?.trees?.[id] || null;
}

/**
 * Build a generator function from a user-supplied spec. If the spec is a
 * function, use it as-is. If it is a string, return a mock generator that
 * emits k pseudo-thoughts based on the template. Otherwise, fall back to a
 * deterministic mock.
 */
function buildGenerator(spec, fallbackK = 3) {
  if (typeof spec === "function") return spec;
  if (typeof spec === "string" && spec.trim().length > 0) {
    const template = spec.trim();
    return async (ctx, k = fallbackK) => {
      const parent = ctx?.node?.thought || ctx?.task || "";
      const out = [];
      const width = Number.isFinite(k) && k > 0 ? k : fallbackK;
      for (let i = 0; i < width; i++) {
        out.push(
          `${template} [branch ${i + 1} from "${String(parent).slice(0, 40)}"]`
        );
      }
      // Seed a conclusion on the first branch at depth >= 2 so tests of goal
      // detection see at least one terminal.
      if ((ctx?.node?.depth ?? 0) >= 2) {
        out[0] = `${template} — final answer: ${String(parent).slice(0, 20)}`;
      }
      return out;
    };
  }
  return async (ctx, k = fallbackK) => {
    const d = ctx?.node?.depth ?? 0;
    const parent = ctx?.node?.thought || ctx?.task || "root";
    const out = [];
    const width = Number.isFinite(k) && k > 0 ? k : fallbackK;
    for (let i = 0; i < width; i++) {
      out.push(`thought at depth ${d + 1} branch ${i + 1} from "${String(parent).slice(0, 40)}"`);
    }
    if (d >= 2) out[0] = `final answer: derived from ${String(parent).slice(0, 20)}`;
    return out;
  };
}

function sanitizeNumber(v, fallback, min = 0, max = 100) {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

export function mountTreeOfThoughtRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : (_req, _res, next) => next();
  const scope = typeof requireScope === "function"
    ? requireScope
    : () => (_req, _res, next) => next();

  // POST /api/v1/reasoning/tot/search
  apiRoute(
    "post",
    "/reasoning/tot/search",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const task = typeof body.task === "string" ? body.task : "";
        if (!task.trim()) {
          return apiError(res, 400, "INVALID_INPUT", "task is required");
        }
        const depth = sanitizeNumber(body.depth, 3, 0, 12);
        const beamWidth = sanitizeNumber(body.beamWidth, 3, 1, 16);
        const k = sanitizeNumber(body.k, 3, 1, 16);
        const pruneThreshold = Number.isFinite(Number(body.pruneThreshold))
          ? Math.max(0, Math.min(1, Number(body.pruneThreshold)))
          : 0;
        const strategy = typeof body.strategy === "string" ? body.strategy.toLowerCase() : "beam";

        const generator = buildGenerator(body.generator, k);
        const opts = { depth, beamWidth, k, pruneThreshold, generator };

        let result;
        if (strategy === "dfs") {
          result = await dfsSearch(task, opts);
        } else if (strategy === "bfs") {
          result = await bfsSearch(task, opts);
        } else {
          result = await beamSearch(task, opts);
        }

        const id = randomUUID();
        const record = {
          id,
          task,
          strategy,
          options: { depth, beamWidth, k, pruneThreshold },
          tree: treeToJson(result.tree),
          bestPath: result.bestPath.map((n) => ({
            id: n.id,
            thought: n.thought,
            depth: n.depth,
            score: n.score,
          })),
          answer: extractAnswer(result.bestPath),
          stats: result.stats,
          savedAt: Date.now(),
        };
        try {
          await saveTree(id, record);
        } catch (err) {
          // Persistence is best-effort; log but still return the result.
          console.warn("[tree-of-thought] failed to save tree", err?.message);
        }

        return res.status(201).json({ _version: 1, ...record });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tot search failed");
      }
    }
  );

  // POST /api/v1/reasoning/tot/expand
  apiRoute(
    "post",
    "/reasoning/tot/expand",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const nodeSpec = body.node || {};
        if (typeof nodeSpec.thought !== "string" || !nodeSpec.thought.trim()) {
          return apiError(res, 400, "INVALID_INPUT", "node.thought is required");
        }
        const options = body.options || {};
        const k = sanitizeNumber(options.k, 3, 1, 16);
        const generator = buildGenerator(options.generator, k);
        const node = new ThoughtNode({
          thought: nodeSpec.thought,
          depth: sanitizeNumber(nodeSpec.depth, 0, 0, 64),
          state: nodeSpec.state && typeof nodeSpec.state === "object" ? nodeSpec.state : {},
        });
        const children = await expandThought(node, { generator, k });
        return res.json({
          _version: 1,
          parent: {
            id: node.id,
            thought: node.thought,
            depth: node.depth,
            score: node.score,
          },
          children: children.map((c) => ({
            id: c.id,
            thought: c.thought,
            depth: c.depth,
            score: c.score,
            terminal: c.terminal,
          })),
          count: children.length,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tot expand failed");
      }
    }
  );

  // POST /api/v1/reasoning/tot/score
  apiRoute(
    "post",
    "/reasoning/tot/score",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const nodeSpec = body.node || {};
        if (typeof nodeSpec.thought !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "node.thought is required");
        }
        const node = new ThoughtNode({
          thought: nodeSpec.thought,
          depth: sanitizeNumber(nodeSpec.depth, 0, 0, 64),
          state: nodeSpec.state && typeof nodeSpec.state === "object" ? nodeSpec.state : {},
        });
        const score = scoreThought(node);
        return res.json({
          _version: 1,
          thought: node.thought,
          depth: node.depth,
          score,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tot score failed");
      }
    }
  );

  // GET /api/v1/reasoning/tot/tree/:id
  apiRoute(
    "get",
    "/reasoning/tot/tree/:id",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const id = req.params.id;
        const record = await getTree(id);
        if (!record) {
          return apiError(res, 404, "NOT_FOUND", `tot tree ${id} not found`);
        }
        const format = String(req.query?.format || "json").toLowerCase();
        if (format === "dot") {
          // Rebuild a minimal ThoughtNode to produce DOT output.
          const rebuild = (obj, parent = null) => {
            const n = new ThoughtNode({
              thought: obj.thought,
              parent,
              depth: obj.depth,
              score: obj.score,
              state: obj.state,
            });
            n.id = obj.id || n.id;
            n.terminal = !!obj.terminal;
            n.pruned = !!obj.pruned;
            if (Array.isArray(obj.children)) {
              for (const c of obj.children) {
                const child = rebuild(c, n);
                n.children.push(child);
              }
            }
            return n;
          };
          const rebuilt = rebuild(record.tree);
          res.setHeader("Content-Type", "text/vnd.graphviz");
          return res.send(treeToDot(rebuilt));
        }
        return res.json({ _version: 1, ...record });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tot tree fetch failed");
      }
    }
  );
}

export default mountTreeOfThoughtRoutes;
