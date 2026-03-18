import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Environment config
const VLLM_URL = process.env.VLLM_URL || "http://localhost:8000";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // optional; protects /v1/chat/completions when set
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;

// Determine backend: explicit BACKEND env, or infer (default: ollama for local dev)
function getBackend() {
  const explicit = process.env.BACKEND?.toLowerCase();
  if (explicit === "ollama" || explicit === "vllm" || explicit === "openai") {
    return explicit;
  }
  if (process.env.VLLM_URL !== undefined && process.env.VLLM_URL !== OLLAMA_URL) {
    return "vllm";
  }
  return "ollama"; // default: Ollama (runs on Windows, easy local setup)
}

const BACKEND = getBackend();

// Model presets per backend (for /config)
const MODEL_PRESETS = {
  ollama: ["llama3.2", "mistral", "llama2", "codellama"],
  vllm: ["meta-llama/Llama-3-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.2"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
};

function buildProxyConfig(backend) {
  switch (backend) {
    case "ollama": {
      return {
        baseUrl: OLLAMA_URL,
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
    }
    case "vllm": {
      return {
        baseUrl: VLLM_URL.replace(/\/$/, ""),
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
    }
    case "openai": {
      if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for OpenAI backend");
      }
      return {
        baseUrl: "https://api.openai.com/v1",
        path: "/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      };
    }
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Rate limit for /v1/chat/completions only
const chatRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

// Optional API key auth for /v1/chat/completions
function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const xKey = req.headers["x-api-key"];
  const key = bearer || xKey;
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid API key. Use Authorization: Bearer <key> or x-api-key header.",
    });
  }
  next();
}

// Structured request logging
function logRequest(req, res, next) {
  const requestId = randomUUID();
  req.requestId = requestId;
  const start = Date.now();
  res.on("finish", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    };
    console.log(JSON.stringify(entry));
  });
  next();
}

// Config endpoint for client (backend, model presets)
app.get("/config", (req, res) => {
  res.json({
    backend: BACKEND,
    modelPresets: MODEL_PRESETS[BACKEND] || [],
    modelPlaceholder: MODEL_PRESETS[BACKEND]?.[0] || "model",
  });
});

app.post("/v1/chat/completions", chatRateLimiter, apiKeyAuth, logRequest, async (req, res) => {
  try {
    const config = buildProxyConfig(BACKEND);
    const url = `${config.baseUrl}${config.path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ ...req.body, stream: true }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({
        error: `${BACKEND} error`,
        status: response.status,
        body: err,
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    for await (const chunk of response.body) {
      res.write(chunk);
      if (res.flush) res.flush();
    }
    res.end();
  } catch (err) {
    console.error("Proxy error:", err.message);
    const hint =
      BACKEND === "vllm"
        ? "Is vLLM running? Try: vllm serve <model> --max-model-len 4096"
        : BACKEND === "ollama"
          ? "Is Ollama running? Try: ollama serve"
          : BACKEND === "openai"
            ? "Check OPENAI_API_KEY is set and valid"
            : "Check backend configuration";

    res.status(502).json({
      error: "Proxy error",
      message: err.message,
      hint,
    });
  }
});

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

app.get("/health", async (req, res) => {
  const url = getHealthUrl(BACKEND);
  if (!url) {
    return res.json({ ok: true, backend: BACKEND, reachable: "unknown" });
  }

  try {
    const headers = {};
    if (BACKEND === "openai" && OPENAI_API_KEY) {
      headers.Authorization = `Bearer ${OPENAI_API_KEY}`;
    }
    const r = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      headers,
    });
    return res.json({
      ok: true,
      backend: BACKEND,
      reachable: r.ok,
      endpoint: BACKEND === "openai" ? "api.openai.com" : url,
    });
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
      ok: false,
      backend: BACKEND,
      error: e.message,
      hint,
    });
  }
});

app.use(express.static(join(__dirname, "client")));

app.listen(PORT, () => {
  console.log(`Proxy: http://localhost:${PORT}`);
  console.log(`Backend: ${BACKEND}`);
  if (BACKEND === "vllm") console.log(`vLLM:  ${VLLM_URL}`);
  if (BACKEND === "ollama") console.log(`Ollama: ${OLLAMA_URL}`);
  if (BACKEND === "openai") console.log(`OpenAI: api.openai.com (key set)`);
});
