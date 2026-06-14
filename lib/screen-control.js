// @ts-check
/**
 * Phase 55.1: Screen-control agent.
 *
 * Pluggable screenshot + mouse/keyboard action recorder and executor with
 * safety rails. The default executor is a mock for tests; real system
 * execution (robotjs, nut-js, etc.) must be wired in explicitly via
 * registerExecutor and opted into by passing the executor name.
 *
 * Storage: JSON-backed via `json-path-store.js` so recorded sessions persist
 * across file, SQLite, or Postgres KV backends without code changes.
 *
 * @module screen-control
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

/** Supported action type identifiers. */
export const ACTION_TYPES = [
  "click",
  "double_click",
  "right_click",
  "drag",
  "type",
  "key",
  "scroll",
  "screenshot",
  "wait",
  "focus_window",
];

const ACTION_TYPE_SET = new Set(ACTION_TYPES);

function storePath() {
  return join(getDataDir(), "screen-control-sessions.json");
}

async function loadStore() {
  const raw = await readJsonPath(storePath(), { version: STORE_VERSION, sessions: {} });
  if (!raw || typeof raw !== "object") return { version: STORE_VERSION, sessions: {} };
  if (!raw.sessions || typeof raw.sessions !== "object") raw.sessions = {};
  if (!raw.version) raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

/**
 * Describes a single screen-control action. Validates its own shape.
 */
export class Action {
  constructor({ type, args = {}, timestamp } = {}) {
    this.type = type;
    this.args = args && typeof args === "object" ? args : {};
    this.timestamp = typeof timestamp === "number" ? timestamp : Date.now();
  }

  validate() {
    if (!this.type || typeof this.type !== "string") {
      throw new Error("Action.type is required");
    }
    if (!ACTION_TYPE_SET.has(this.type)) {
      throw new Error(`Unknown action type: ${this.type}`);
    }
    const args = this.args || {};
    switch (this.type) {
      case "click":
      case "double_click":
      case "right_click": {
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
          throw new Error(`${this.type} requires numeric x and y`);
        }
        if (args.x < 0 || args.y < 0) {
          throw new Error(`${this.type} coordinates must be non-negative`);
        }
        break;
      }
      case "drag": {
        if (
          !Number.isFinite(args.fromX) ||
          !Number.isFinite(args.fromY) ||
          !Number.isFinite(args.toX) ||
          !Number.isFinite(args.toY)
        ) {
          throw new Error("drag requires numeric fromX, fromY, toX, toY");
        }
        break;
      }
      case "type": {
        if (typeof args.text !== "string") {
          throw new Error("type requires a string text");
        }
        break;
      }
      case "key": {
        if (typeof args.key !== "string" || !args.key) {
          throw new Error("key requires a non-empty key");
        }
        break;
      }
      case "scroll": {
        if (!Number.isFinite(args.dx) && !Number.isFinite(args.dy)) {
          throw new Error("scroll requires numeric dx or dy");
        }
        break;
      }
      case "wait": {
        if (!Number.isFinite(args.ms) || args.ms < 0) {
          throw new Error("wait requires non-negative numeric ms");
        }
        break;
      }
      case "focus_window": {
        if (typeof args.title !== "string" || !args.title) {
          throw new Error("focus_window requires a non-empty title");
        }
        break;
      }
      case "screenshot": {
        // no required args
        break;
      }
      default:
        throw new Error(`Unknown action type: ${this.type}`);
    }
    return true;
  }

  toJSON() {
    return { type: this.type, args: this.args, timestamp: this.timestamp };
  }

  static fromJSON(json) {
    if (!json || typeof json !== "object") {
      throw new Error("Action.fromJSON requires an object");
    }
    return new Action({ type: json.type, args: json.args, timestamp: json.timestamp });
  }
}

/**
 * An ordered list of actions.
 */
export class ActionSequence {
  constructor(actions = []) {
    this.actions = [];
    for (const a of actions) {
      if (a instanceof Action) {
        this.actions.push(a);
      } else if (a && typeof a === "object") {
        this.actions.push(Action.fromJSON(a));
      }
    }
  }

  add(action) {
    if (!(action instanceof Action)) {
      if (action && typeof action === "object") {
        action = Action.fromJSON(action);
      } else {
        throw new Error("add requires an Action instance or plain object");
      }
    }
    action.validate();
    this.actions.push(action);
    return this;
  }

  remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.actions.length) {
      throw new Error("remove requires a valid index");
    }
    return this.actions.splice(index, 1)[0];
  }

  getActions() {
    return this.actions.slice();
  }

  length() {
    return this.actions.length;
  }

  toJSON() {
    return { actions: this.actions.map((a) => a.toJSON()) };
  }

  static fromJSON(json) {
    if (!json || typeof json !== "object") {
      throw new Error("ActionSequence.fromJSON requires an object");
    }
    const actions = Array.isArray(json.actions) ? json.actions : [];
    return new ActionSequence(actions.map((a) => Action.fromJSON(a)));
  }
}

// ----------------------------------------------------------------------------
// Pluggable executor registry
// ----------------------------------------------------------------------------

const executors = new Map();

/**
 * Register an executor under a name. An executor is an object mapping action
 * types to async functions that receive the action args.
 */
export function registerExecutor(name, executor) {
  if (!name || typeof name !== "string") {
    throw new Error("registerExecutor requires a name");
  }
  if (!executor || typeof executor !== "object") {
    throw new Error("registerExecutor requires an executor object");
  }
  executors.set(name, executor);
}

/**
 * Look up a registered executor. Returns undefined if unknown.
 */
export function getExecutor(name) {
  return executors.get(name);
}

/** Mock executor — echoes inputs without touching the real system. */
export const mockExecutor = {
  click: async (args) => ({ success: true, position: { x: args.x, y: args.y } }),
  double_click: async (args) => ({ success: true, position: { x: args.x, y: args.y } }),
  right_click: async (args) => ({ success: true, position: { x: args.x, y: args.y } }),
  type: async (args) => ({ success: true, text: args.text }),
  key: async (args) => ({ success: true, key: args.key }),
  screenshot: async () => ({ data: "base64==", width: 800, height: 600 }),
  drag: async (args) => ({
    success: true,
    from: { x: args.fromX, y: args.fromY },
    to: { x: args.toX, y: args.toY },
  }),
  scroll: async (args) => ({ success: true, dx: args.dx || 0, dy: args.dy || 0 }),
  wait: async (args) => new Promise((r) => setTimeout(r, Math.min(args.ms || 0, 50))),
  focus_window: async (args) => ({ success: true, title: args.title }),
};

registerExecutor("mock", mockExecutor);

// ----------------------------------------------------------------------------
// Safety rails
// ----------------------------------------------------------------------------

/**
 * Patterns that must never be typed or sent as key combos.
 */
export const FORBIDDEN_PATTERNS = {
  typing: [/rm\s+-rf/i, /DROP\s+TABLE/i, /--no-verify/i, /sudo\s+rm/i, /mkfs\./i, /:\(\)\s*\{/],
  keys: [/ctrl\+alt\+del/i, /cmd\+alt\+esc/i],
};

/**
 * Validate an action against forbidden patterns and policy.
 * Returns { allowed: boolean, reason?: string }.
 */
export function validateAction(action, policy = {}) {
  if (!(action instanceof Action)) {
    try {
      action = Action.fromJSON(action);
    } catch (err) {
      return { allowed: false, reason: `invalid action: ${err.message}` };
    }
  }
  try {
    action.validate();
  } catch (err) {
    return { allowed: false, reason: err.message };
  }

  // Policy-level allow/deny lists.
  if (Array.isArray(policy.allowedTypes) && policy.allowedTypes.length > 0) {
    if (!policy.allowedTypes.includes(action.type)) {
      return { allowed: false, reason: `action type '${action.type}' not in allowedTypes policy` };
    }
  }
  if (Array.isArray(policy.deniedTypes) && policy.deniedTypes.includes(action.type)) {
    return { allowed: false, reason: `action type '${action.type}' is denied by policy` };
  }

  if (action.type === "type") {
    const text = String(action.args?.text ?? "");
    for (const pattern of FORBIDDEN_PATTERNS.typing) {
      if (pattern.test(text)) {
        return { allowed: false, reason: `typing text matches forbidden pattern ${pattern}` };
      }
    }
    if (policy.maxTypeLength && text.length > policy.maxTypeLength) {
      return { allowed: false, reason: `typing text exceeds maxTypeLength (${policy.maxTypeLength})` };
    }
  }

  if (action.type === "key") {
    const key = String(action.args?.key ?? "");
    for (const pattern of FORBIDDEN_PATTERNS.keys) {
      if (pattern.test(key)) {
        return { allowed: false, reason: `key '${key}' matches forbidden combo ${pattern}` };
      }
    }
  }

  // Coordinate bounds policy
  if (
    (action.type === "click" || action.type === "double_click" || action.type === "right_click") &&
    policy.screenBounds
  ) {
    const { width, height } = policy.screenBounds;
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      (action.args.x > width || action.args.y > height)
    ) {
      return { allowed: false, reason: `coordinates out of screen bounds` };
    }
  }

  return { allowed: true };
}

/**
 * Return a sanitized copy of the action with dangerous components removed.
 * If the action is irrecoverably dangerous (e.g. forbidden key), returns null.
 */
export function sanitizeAction(action) {
  let a;
  if (action instanceof Action) {
    a = new Action({ type: action.type, args: { ...action.args }, timestamp: action.timestamp });
  } else if (action && typeof action === "object") {
    a = new Action({ type: action.type, args: { ...(action.args || {}) }, timestamp: action.timestamp });
  } else {
    return null;
  }

  if (a.type === "type") {
    let text = String(a.args?.text ?? "");
    for (const pattern of FORBIDDEN_PATTERNS.typing) {
      text = text.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), "[REDACTED]");
    }
    a.args = { ...a.args, text };
    return a;
  }

  if (a.type === "key") {
    const key = String(a.args?.key ?? "");
    for (const pattern of FORBIDDEN_PATTERNS.keys) {
      if (pattern.test(key)) {
        return null;
      }
    }
    return a;
  }

  return a;
}

// ----------------------------------------------------------------------------
// Execution
// ----------------------------------------------------------------------------

function resolveExecutor(name) {
  if (!name) return mockExecutor;
  const found = executors.get(name);
  if (!found) {
    throw new Error(`Unknown executor: ${name}`);
  }
  return found;
}

/**
 * Execute a single action.
 * @param {Action|object} action
 * @param {object} [options] - { executor, policy, dryRun }
 * @returns {Promise<{ success: boolean, result?: any, warnings?: string[], reason?: string, dryRun?: boolean }>}
 */
export async function executeAction(action, options = {}) {
  const warnings = [];
  let normalized;
  if (action instanceof Action) {
    normalized = action;
  } else {
    try {
      normalized = Action.fromJSON(action);
    } catch (err) {
      return { success: false, reason: `invalid action: ${err.message}`, warnings };
    }
  }

  const check = validateAction(normalized, options.policy || {});
  if (!check.allowed) {
    return { success: false, reason: check.reason, warnings };
  }

  if (options.dryRun) {
    return { success: true, result: null, dryRun: true, warnings };
  }

  let executor;
  try {
    executor = resolveExecutor(options.executor);
  } catch (err) {
    return { success: false, reason: err.message, warnings };
  }

  const handler = executor[normalized.type];
  if (typeof handler !== "function") {
    return { success: false, reason: `executor missing handler for ${normalized.type}`, warnings };
  }

  try {
    const result = await handler(normalized.args || {});
    return { success: true, result, warnings };
  } catch (err) {
    return { success: false, reason: err?.message || "executor failed", warnings };
  }
}

/**
 * Execute a sequence of actions in order. Stops on the first failure unless
 * `options.continueOnFailure` is true.
 * @param {ActionSequence|Action[]|object[]} sequence
 * @param {object} [options]
 * @returns {Promise<{ steps: Array, success: boolean, stoppedAt?: number }>}
 */
export async function executeSequence(sequence, options = {}) {
  let actions;
  if (sequence instanceof ActionSequence) {
    actions = sequence.getActions();
  } else if (Array.isArray(sequence)) {
    actions = sequence.map((a) => (a instanceof Action ? a : Action.fromJSON(a)));
  } else if (sequence && Array.isArray(sequence.actions)) {
    actions = sequence.actions.map((a) => (a instanceof Action ? a : Action.fromJSON(a)));
  } else {
    return { steps: [], success: true };
  }

  if (actions.length === 0) {
    return { steps: [], success: true };
  }

  const steps = [];
  for (let i = 0; i < actions.length; i++) {
    const step = await executeAction(actions[i], options);
    steps.push({ index: i, action: actions[i].toJSON(), ...step });
    if (!step.success && !options.continueOnFailure) {
      return { steps, success: false, stoppedAt: i };
    }
  }
  return { steps, success: steps.every((s) => s.success) };
}

// ----------------------------------------------------------------------------
// Recording
// ----------------------------------------------------------------------------

/**
 * In-memory recorder. Collects actions and returns them as a sequence.
 */
export class ActionRecorder {
  constructor() {
    this.actions = [];
    this.startTime = null;
    this.stopTime = null;
    this.recording = false;
  }

  start() {
    this.actions = [];
    this.startTime = Date.now();
    this.stopTime = null;
    this.recording = true;
    return this;
  }

  record(action) {
    if (!this.recording) {
      throw new Error("recorder is not started");
    }
    let a;
    if (action instanceof Action) {
      a = action;
    } else {
      a = Action.fromJSON(action);
    }
    a.validate();
    this.actions.push(a);
    return a;
  }

  stop() {
    this.recording = false;
    this.stopTime = Date.now();
    return this.getSequence();
  }

  getSequence() {
    return new ActionSequence(this.actions);
  }
}

// ----------------------------------------------------------------------------
// Durable sessions
// ----------------------------------------------------------------------------

/**
 * Create a persisted recording session.
 * @param {string} name
 * @param {object} [metadata]
 * @returns {Promise<object>}
 */
export async function createSession(name, metadata = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("session name is required");
  }
  const id = `scrsess_${randomUUID()}`;
  const session = {
    id,
    name,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    workspaceId: metadata?.workspaceId || "default",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    actions: [],
  };
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.sessions[id] = session;
    await saveStore(store);
    return session;
  });
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const store = await loadStore();
  return store.sessions[sessionId] || null;
}

export async function listSessions(workspaceId) {
  const store = await loadStore();
  const all = Object.values(store.sessions);
  if (!workspaceId) return all;
  return all.filter((s) => s.workspaceId === workspaceId);
}

export async function recordSessionAction(sessionId, action) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) {
      throw new Error(`session ${sessionId} not found`);
    }
    let a;
    if (action instanceof Action) a = action;
    else a = Action.fromJSON(action);
    a.validate();
    session.actions.push(a.toJSON());
    session.updatedAt = Date.now();
    await saveStore(store);
    return a.toJSON();
  });
}

export async function getSessionActions(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;
  return session.actions.slice();
}

// ----------------------------------------------------------------------------
// High-level primitives
// ----------------------------------------------------------------------------

export async function clickAt(x, y, options = {}) {
  const action = new Action({ type: "click", args: { x, y } });
  return executeAction(action, options);
}

export async function typeText(text, options = {}) {
  const action = new Action({ type: "type", args: { text } });
  return executeAction(action, options);
}

export async function pressKey(key, options = {}) {
  const action = new Action({ type: "key", args: { key } });
  return executeAction(action, options);
}

export async function takeScreenshot(options = {}) {
  const action = new Action({ type: "screenshot", args: {} });
  return executeAction(action, options);
}

export async function waitMs(ms) {
  const action = new Action({ type: "wait", args: { ms } });
  return executeAction(action);
}

// ----------------------------------------------------------------------------
// Undo / rollback
// ----------------------------------------------------------------------------

/**
 * Remove the last recorded action from the persisted session.
 */
export async function undoLastAction(sessionId) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) {
      throw new Error(`session ${sessionId} not found`);
    }
    if (session.actions.length === 0) {
      return { undone: null, remaining: 0 };
    }
    const undone = session.actions.pop();
    session.updatedAt = Date.now();
    await saveStore(store);
    return { undone, remaining: session.actions.length };
  });
}

export const _internals = { storePath, loadStore, saveStore, executors };
