import rateLimit from "express-rate-limit";

export default function mountTaskRoutes(app, deps) {
  const {
    apiKeyAuth,
    requireScope,
    logRequest,
    apiError,
    buildProxyConfig,
    BACKEND,
    MODEL_PRESETS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
    sanitizeWorkspace,
    emitEvent,
  } = deps;

  const TASK_PLAN_SYSTEM_PROMPT = `You are a task planning assistant. Given the user's messages, produce a structured task plan as valid JSON inside a fenced code block.

Output format: a single JSON object in a \`\`\`json ... \`\`\` code block, conforming to this schema:

{
  "type": "task",
  "id": "optional-unique-id",
  "name": "Human-readable task name (required)",
  "steps": [
    { "action": "action-type-or-description (required)", "payload": { "key": "value" } }
  ],
  "requiresApproval": true
}

Rules:
- type must be exactly "task"
- name: required, non-empty string
- steps: required array, at least one step; each step needs non-empty "action" string; "payload" is optional object
- requiresApproval: optional boolean; set true for destructive or high-risk tasks (deploy, delete, shell commands)
- Return only the code block, no other text before or after the JSON`;

  function extractTaskJsonFromResponse(text) {
    if (!text || typeof text !== "string") return null;
    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = jsonBlock ? jsonBlock[1].trim() : text.trim();
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function validateTaskPlan(plan) {
    if (!plan || typeof plan !== "object") return "Plan must be an object";
    if (plan.type !== "task") return "Plan must have type 'task'";
    if (!plan.name || typeof plan.name !== "string" || !plan.name.trim())
      return "Plan must have a non-empty name";
    if (!Array.isArray(plan.steps) || plan.steps.length < 1) return "Plan must have at least one step";
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (!s || typeof s !== "object") return `Step ${i + 1}: must be an object`;
      if (!s.action || typeof s.action !== "string" || !String(s.action).trim())
        return `Step ${i + 1}: must have non-empty action`;
      if (s.payload !== undefined) {
        if (s.payload === null || Array.isArray(s.payload) || typeof s.payload !== "object")
          return `Step ${i + 1}: payload must be an object`;
      }
    }
    if (plan.requiresApproval !== undefined && typeof plan.requiresApproval !== "boolean")
      return "requiresApproval must be a boolean";
    return null;
  }

  const taskPlanRateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post("/v1/tasks/plan", taskPlanRateLimiter, apiKeyAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { messages, model } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return apiError(res, 400, "INVALID_BODY", "messages must be a non-empty array", "Send a non-empty messages array in the request body.");
      }
      const modelName = typeof model === "string" && model.trim() ? model.trim() : MODEL_PRESETS[BACKEND]?.[0] || "llama3.2";

      const config = buildProxyConfig(BACKEND);
      const url = `${config.baseUrl}${config.path}`;

      const llmMessages = [
        { role: "system", content: TASK_PLAN_SYSTEM_PROMPT },
        ...messages.map((m) => ({
          role: m.role || "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })),
      ];

      const response = await fetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({
          model: modelName,
          messages: llmMessages,
          stream: false,
          temperature: 0.3,
          max_tokens: 2048,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        const code = response.status === 429 ? "RATE_LIMITED" : "BACKEND_ERROR";
        return res.status(response.status).json({
          error: `${BACKEND} error`,
          code,
          hint: response.status === 429 ? "Backend rate limit exceeded; retry later." : (err || "Backend returned an error.").slice(0, 500),
        });
      }

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content || data.message?.content || "";
      const parsed = extractTaskJsonFromResponse(rawContent);

      if (!parsed) {
        return res.status(400).json({
          error: "Could not parse JSON task plan from LLM response",
          code: "PARSE_ERROR",
          hint: "Check that the LLM returns valid JSON in a fenced code block.",
          raw: rawContent?.slice(0, 500),
        });
      }

      const validationError = validateTaskPlan(parsed);
      if (validationError) {
        return res.status(400).json({
          error: validationError,
          code: "VALIDATION_ERROR",
          hint: "Ensure plan has type 'task', name, and steps with non-empty action.",
          raw: rawContent?.slice(0, 500),
        });
      }

      const planWorkspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      await emitEvent("plan_created", { plan: parsed, raw: rawContent?.slice(0, 500) }, { workspaceId: planWorkspace, userId: req.userId });
      res.json({ plan: parsed, raw: rawContent });
    } catch (err) {
      console.error("Task plan error:", err.message);
      const hint =
        BACKEND === "vllm"
          ? "Is vLLM running? Try: vllm serve <model> --max-model-len 4096"
          : BACKEND === "ollama"
            ? "Is Ollama running? Try: ollama serve"
            : BACKEND === "openai"
              ? "Check OPENAI_API_KEY is set and valid"
              : "Check backend configuration";

      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, hint);
    }
  });
}
