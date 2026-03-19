/**
 * SiskelBot automations system (Phase 6).
 * Loads defaults from automations.defaults.json and merges with user-created localStorage data.
 * Schema: { id, name, trigger, steps, inputs, outputs }
 */
(function (global) {
  const STORAGE_VERSION = 1;
  const STORAGE_KEY = "siskelbot-automations";
  const MAX_RECIPE_SIZE_BYTES = 64 * 1024; // 64KB
  const MAX_NAME_LENGTH = 128;
  const MAX_STEP_ACTION_LENGTH = 512;

  const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\s\-_.]{0,126}$/;

  /**
   * Sanitize recipe name: trim, limit length, remove unsafe chars.
   * @param {string} name
   * @returns {string}
   */
  function sanitizeName(name) {
    if (typeof name !== "string") return "";
    let s = String(name).trim().slice(0, MAX_NAME_LENGTH);
    return s.replace(/[<>"'\u0000-\u001F]/g, "") || "Untitled";
  }

  /**
   * Sanitize step action content.
   * @param {string} action
   * @returns {string}
   */
  function sanitizeStepAction(action) {
    if (typeof action !== "string") return "";
    return String(action).trim().slice(0, MAX_STEP_ACTION_LENGTH).replace(/[<>"\u0000-\u001F]/g, "") || "Unnamed step";
  }

  /**
   * Validate recipe size.
   * @param {object} recipe
   * @returns {{ valid: boolean, error?: string }}
   */
  function validateRecipeSize(recipe) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(recipe)).length;
      if (bytes > MAX_RECIPE_SIZE_BYTES) {
        return { valid: false, error: `Recipe exceeds max size (${MAX_RECIPE_SIZE_BYTES} bytes)` };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: "Invalid recipe" };
    }
  }

  const DEFAULTS_FALLBACK = {
    automations: [
      {
        id: "ship-repo",
        name: "Ship this repo",
        trigger: "manual",
        steps: [
          { action: "Review code changes and tests", requiresApproval: false, payload: {} },
          { action: "Run task planner for deployment steps", requiresApproval: false, payload: { context: "prepare for deploy" } },
          { action: "Create PR or push to main", requiresApproval: true, payload: {} },
          { action: "Trigger deploy (Vercel/Render)", requiresApproval: true, payload: {} },
        ],
        inputs: { repo: "", branch: "" },
        outputs: { prUrl: "", deployUrl: "" },
      },
      {
        id: "review-pr-patch",
        name: "Review PR and patch",
        trigger: "manual",
        steps: [
          { action: "Fetch PR diff and summarize", requiresApproval: false, payload: {} },
          { action: "Run task planner for review checklist", requiresApproval: false, payload: { context: "code review" } },
          { action: "Suggest or apply patches (via chat)", requiresApproval: true, payload: {} },
          { action: "Approve or request changes", requiresApproval: true, payload: {} },
        ],
        inputs: { owner: "", repo: "", prNumber: "" },
        outputs: { summary: "", reviewComment: "" },
      },
      {
        id: "prepare-deployment",
        name: "Prepare deployment",
        trigger: "manual",
        steps: [
          { action: "Verify build passes locally", requiresApproval: false, payload: {} },
          { action: "Check env vars and secrets", requiresApproval: false, payload: {} },
          { action: "Run task planner for deployment checklist", requiresApproval: false, payload: { context: "pre-deploy" } },
          { action: "Trigger deploy", requiresApproval: true, payload: {} },
        ],
        inputs: { project: "", env: "production" },
        outputs: { deployUrl: "", status: "" },
      },
      {
        id: "notes-to-plan",
        name: "Notes to implementation plan",
        trigger: "manual",
        steps: [
          { action: "Load user notes (from chat or clipboard)", requiresApproval: false, payload: {} },
          { action: "Run task planner to convert notes into steps", requiresApproval: false, payload: { context: "notes to implementation" } },
          { action: "Review and refine plan with chat", requiresApproval: false, payload: {} },
        ],
        inputs: { notes: "" },
        outputs: { plan: "" },
      },
      {
        id: "repo-summary-roadmap",
        name: "Repo summary and roadmap",
        trigger: "manual",
        steps: [
          { action: "Fetch repo structure and README", requiresApproval: false, payload: {} },
          { action: "Run task planner for summary and roadmap", requiresApproval: false, payload: { context: "repo overview" } },
          { action: "Add summary to chat", requiresApproval: false, payload: {} },
        ],
        inputs: { owner: "", repo: "" },
        outputs: { summary: "", roadmap: "" },
      },
    ],
  };

  async function loadDefaults() {
    try {
      const r = await fetch("/automations.defaults.json");
      if (r.ok) {
        const data = await r.json();
        if (data?.automations?.length) return data;
      }
    } catch (_) {}
    return DEFAULTS_FALLBACK;
  }

  function migratePayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const version = payload._version;
    if (version === STORAGE_VERSION) return payload;
    if (version == null) {
      if (Array.isArray(payload)) return null;
      payload._version = STORAGE_VERSION;
      return payload;
    }
    return payload;
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return migratePayload(parsed);
    } catch (_) {
      return null;
    }
  }

  function mergeAutomations(defaults, stored) {
    const defaultIds = new Set((defaults.automations || []).map((a) => a.id));
    const userAutomations = (stored?.automations || []).filter((a) => a?.id && a.id.startsWith("user-"));
    return [...(defaults.automations || []), ...userAutomations];
  }

  function saveAutomations(automations) {
    try {
      const payload = { _version: STORAGE_VERSION, automations: automations || [] };
      const str = JSON.stringify(payload);
      if (new TextEncoder().encode(str).length > MAX_RECIPE_SIZE_BYTES * 10) {
        console.warn("SiskelBot: automations payload very large");
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("SiskelBot: failed to save automations", e);
    }
  }

  function generateId() {
    return "user-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function sanitizeRecipe(recipe) {
    if (!recipe || typeof recipe !== "object") return null;
    const sanitized = {
      id: recipe.id || generateId(),
      name: sanitizeName(recipe.name),
      trigger: typeof recipe.trigger === "string" ? recipe.trigger : "manual",
      steps: [],
      inputs: typeof recipe.inputs === "object" && recipe.inputs !== null ? recipe.inputs : {},
      outputs: typeof recipe.outputs === "object" && recipe.outputs !== null ? recipe.outputs : {},
    };
    if (Array.isArray(recipe.steps)) {
      for (const s of recipe.steps) {
        if (s && typeof s === "object" && s.action) {
          sanitized.steps.push({
            action: sanitizeStepAction(s.action),
            requiresApproval: Boolean(s.requiresApproval),
            payload: s.payload && typeof s.payload === "object" && !Array.isArray(s.payload) ? s.payload : {},
          });
        }
      }
    }
    return sanitized;
  }

  global.SiskelBotAutomations = {
    STORAGE_VERSION,
    STORAGE_KEY,
    MAX_RECIPE_SIZE_BYTES,
    MAX_NAME_LENGTH,
    MAX_STEP_ACTION_LENGTH,
    loadDefaults,
    loadFromStorage,
    mergeAutomations,
    saveAutomations,
    generateId,
    sanitizeName,
    sanitizeStepAction,
    sanitizeRecipe,
    validateRecipeSize,
    DEFAULTS_FALLBACK,
  };
})(typeof window !== "undefined" ? window : globalThis);
