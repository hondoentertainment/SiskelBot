import { runStartupChecks, getCachedResults } from "../lib/startup-checks.js";

export default function mountHealthRoutes(app, deps) {
  const {
    BACKEND,
    OPENAI_API_KEY,
    OLLAMA_URL,
    VLLM_URL,
    metricsEnabled,
    renderPrometheus,
    storage,
  } = deps;

  const HEALTH_CACHE_TTL_MS = 5000;
  let healthCache = null;

  function getHealthUrl(backend) {
    switch (backend) {
      case "ollama":
        return `${OLLAMA_URL}/api/tags`;
      case "vllm":
        return `${VLLM_URL}/v1/models`;
      case "openai":
        return "https://api.openai.com/v1/models";
      default:
        return null;
    }
  }

  async function probeBackend(name, url, headers = {}) {
    const start = Date.now();
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        headers,
      });
      return {
        reachable: r.ok,
        latencyMs: Date.now() - start,
        error: r.ok ? undefined : `HTTP ${r.status}`,
      };
    } catch (e) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        error: e.message,
      };
    }
  }

  async function runHealthChecks() {
    const backends = {};
    const checks = [];

    const ollamaUrl = getHealthUrl("ollama");
    if (ollamaUrl) {
      checks.push(
        probeBackend("ollama", ollamaUrl).then((r) => {
          backends.ollama = r;
        })
      );
    }

    const vllmUrl = getHealthUrl("vllm");
    if (vllmUrl) {
      checks.push(
        probeBackend("vllm", vllmUrl).then((r) => {
          backends.vllm = r;
        })
      );
    }

    if (OPENAI_API_KEY) {
      checks.push(
        probeBackend("openai", "https://api.openai.com/v1/models", {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        }).then((r) => {
          backends.openai = r;
        })
      );
    }

    await Promise.all(checks);

    const active = backends[BACKEND];
    const reachable = active?.reachable ?? false;
    const latencyMs = active?.latencyMs ?? null;
    const lastChecked = new Date().toISOString();

    return {
      backend: BACKEND,
      reachable,
      latencyMs,
      lastChecked,
      backends,
    };
  }

  // Expose runHealthChecks for other routes (admin, integrations)
  deps.runHealthChecks = runHealthChecks;

  // Metrics
  const METRICS_PATH = (process.env.METRICS_PATH || "/metrics").replace(/^\/+/, "/").replace(/\/+$/, "") || "/metrics";
  const METRICS_PROTECTED = process.env.METRICS_PROTECTED === "1";
  const METRICS_SECRET = process.env.METRICS_SECRET?.trim() || null;

  function metricsAuth(req, res, next) {
    if (!METRICS_PROTECTED) return next();
    const adminKey = process.env.ADMIN_API_KEY;
    const secret = METRICS_SECRET;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
    const querySecret = req.query?.secret;
    const xKey = req.headers["x-admin-api-key"];
    const key = bearer || xKey;
    if (secret && (querySecret === secret || bearer === secret)) return next();
    if (adminKey && key && key === adminKey) return next();
    if (secret || adminKey) {
      return res.status(401).json({ error: "Metrics require authentication", code: "AUTH_REQUIRED", hint: "Use ?secret=<METRICS_SECRET> or Authorization: Bearer <ADMIN_API_KEY>" });
    }
    next();
  }

  if (metricsEnabled()) {
    app.get(METRICS_PATH, metricsAuth, (req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(renderPrometheus());
    });
  }

  // Integration health check
  app.get("/health/integrations", async (req, res) => {
    const cached = getCachedResults();
    if (cached) {
      return res.json(cached);
    }
    try {
      const results = await runStartupChecks();
      return res.json(results);
    } catch (err) {
      return res.status(503).json({ error: "Integration check failed", message: err.message });
    }
  });

  // Liveness probe
  app.get("/health/live", (req, res) => {
    res.status(200).json({ ok: true, status: "alive" });
  });

  // Readiness probe
  app.get("/health/ready", async (req, res) => {
    try {
      await storage.listWorkspaces("anonymous");
    } catch (e) {
      return res.status(503).json({ ok: false, status: "not_ready", reason: "storage_unavailable", error: e.message });
    }
    try {
      const data = await runHealthChecks();
      if (!data.reachable) {
        return res.status(503).json({ ok: false, status: "not_ready", reason: "backend_unreachable", backend: BACKEND });
      }
      res.status(200).json({ ok: true, status: "ready", backend: BACKEND });
    } catch (e) {
      res.status(503).json({ ok: false, status: "not_ready", reason: "health_check_failed", error: e.message });
    }
  });

  app.get("/health", async (req, res) => {
    const now = Date.now();
    const bypass = req.query?.refresh === "1";

    if (!bypass && healthCache && now - healthCache.timestamp < HEALTH_CACHE_TTL_MS) {
      return res.json({
        ...healthCache.data,
        cached: true,
      });
    }

    try {
      const data = await runHealthChecks();
      healthCache = { data, timestamp: now };
      return res.json(data);
    } catch (e) {
      const hint =
        BACKEND === "vllm"
          ? "Start vLLM: vllm serve <model> --max-model-len 4096"
          : BACKEND === "ollama"
            ? "Start Ollama: ollama serve"
            : BACKEND === "openai"
              ? "Check OPENAI_API_KEY"
              : "Check backend configuration";

      return res.status(503).json({
        error: "Health check failed",
        code: "BACKEND_UNREACHABLE",
        hint,
        backend: BACKEND,
        reachable: false,
        lastChecked: new Date().toISOString(),
      });
    }
  });
}
