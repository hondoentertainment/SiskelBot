/**
 * Phase 21: Workflow Engine
 * Multi-step automated workflows with triggers, conditions, and variable interpolation.
 * Storage: data/workflows/{workspaceId}/
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function workflowsPath(workspaceId) {
  return join(getDataDir(), "workflows", sanitizeWorkspace(workspaceId), "workflows.json");
}

function runsPath(workspaceId) {
  return join(getDataDir(), "workflows", sanitizeWorkspace(workspaceId), "runs.json");
}

/**
 * Interpolate {{variables.name}}, {{steps.stepId.output}}, {{trigger.input}} in a string.
 */
function interpolate(template, ctx) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const parts = expr.trim().split(".");
    let value = ctx;
    for (const part of parts) {
      if (value == null) return "";
      value = value[part];
    }
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Deep-interpolate all string values in an object or array.
 */
function interpolateDeep(obj, ctx) {
  if (typeof obj === "string") return interpolate(obj, ctx);
  if (Array.isArray(obj)) return obj.map((item) => interpolateDeep(item, ctx));
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = interpolateDeep(val, ctx);
    }
    return result;
  }
  return obj;
}

/**
 * Evaluate a simple condition expression against context.
 * Supports: "steps.stepId.output == 'value'", "variables.flag == true", etc.
 */
function evaluateCondition(expression, ctx) {
  if (!expression || typeof expression !== "string") return false;
  const interpolated = interpolate(expression, ctx);
  // Simple truthiness check after interpolation
  const trimmed = interpolated.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return true;
  if (trimmed === "false" || trimmed === "0" || trimmed === "no" || trimmed === "") return false;

  // Support simple comparisons: "value == value", "value != value"
  const eqMatch = expression.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) {
    const left = interpolate("{{" + eqMatch[1].trim() + "}}", ctx);
    let right = eqMatch[2].trim();
    // Strip quotes from right side
    if ((right.startsWith("'") && right.endsWith("'")) || (right.startsWith('"') && right.endsWith('"'))) {
      right = right.slice(1, -1);
    } else {
      right = interpolate("{{" + right + "}}", ctx);
    }
    return left === right;
  }

  const neqMatch = expression.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const left = interpolate("{{" + neqMatch[1].trim() + "}}", ctx);
    let right = neqMatch[2].trim();
    if ((right.startsWith("'") && right.endsWith("'")) || (right.startsWith('"') && right.endsWith('"'))) {
      right = right.slice(1, -1);
    } else {
      right = interpolate("{{" + right + "}}", ctx);
    }
    return left !== right;
  }

  return Boolean(interpolated);
}

// --- Step executors ---

async function executeChatStep(config, _ctx) {
  const { messages, model, agentMode } = config;
  return { response: `[chat] model=${model || "default"} agentMode=${!!agentMode} messages=${Array.isArray(messages) ? messages.length : 0}` };
}

async function executeRecipeStep(config, _ctx) {
  const { recipeName } = config;
  return { recipe: recipeName, executed: true };
}

async function executeHttpStep(config, _ctx) {
  const { url, method, headers, body } = config;
  try {
    const opts = {
      method: (method || "GET").toUpperCase(),
      headers: headers || {},
    };
    if (body && opts.method !== "GET") {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!opts.headers["content-type"] && !opts.headers["Content-Type"]) {
        opts.headers["Content-Type"] = "application/json";
      }
    }
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: resp.status, data };
  } catch (err) {
    throw new Error(`HTTP request failed: ${err.message}`, { cause: err });
  }
}

function executeTransformStep(config, ctx) {
  const { expression } = config;
  const result = interpolate(expression, ctx);
  return { result };
}

function executeNotifyStep(config, _ctx) {
  const { channel, message } = config;
  return { notified: true, channel: channel || "default", message };
}

// --- Core engine ---

export async function createWorkflow(workspaceId, definition) {
  const ws = sanitizeWorkspace(workspaceId);
  const filePath = workflowsPath(ws);

  const workflow = {
    id: definition.id || randomUUID(),
    name: definition.name || "Untitled Workflow",
    description: definition.description || "",
    workspaceId: ws,
    trigger: definition.trigger || { type: "manual", config: {} },
    steps: Array.isArray(definition.steps) ? definition.steps : [],
    variables: definition.variables || {},
    enabled: definition.enabled !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await withPathLock(filePath, async () => {
    const workflows = await readJsonPath(filePath, []);
    workflows.push(workflow);
    await writeJsonPath(filePath, workflows);
  });

  return workflow;
}

export async function updateWorkflow(workflowId, updates) {
  let updated = null;
  const dataDir = getDataDir();
  const wsDir = join(dataDir, "workflows");

  // We need to find which workspace has this workflow
  // Search across all workspace workflow files
  const { readdirSync, existsSync } = await import("fs");
  if (!existsSync(wsDir)) return null;

  const dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  for (const dir of dirs) {
    const filePath = workflowsPath(dir);
    await withPathLock(filePath, async () => {
      const workflows = await readJsonPath(filePath, []);
      const idx = workflows.findIndex((w) => w.id === workflowId);
      if (idx !== -1) {
        const allowed = ["name", "description", "trigger", "steps", "variables", "enabled"];
        for (const key of allowed) {
          if (updates[key] !== undefined) {
            workflows[idx][key] = updates[key];
          }
        }
        workflows[idx].updatedAt = new Date().toISOString();
        updated = workflows[idx];
        await writeJsonPath(filePath, workflows);
      }
    });
    if (updated) break;
  }
  return updated;
}

export async function deleteWorkflow(workflowId) {
  const dataDir = getDataDir();
  const wsDir = join(dataDir, "workflows");
  const { readdirSync, existsSync } = await import("fs");
  if (!existsSync(wsDir)) return false;

  const dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  let deleted = false;

  for (const dir of dirs) {
    const filePath = workflowsPath(dir);
    await withPathLock(filePath, async () => {
      const workflows = await readJsonPath(filePath, []);
      const idx = workflows.findIndex((w) => w.id === workflowId);
      if (idx !== -1) {
        workflows.splice(idx, 1);
        await writeJsonPath(filePath, workflows);
        deleted = true;
      }
    });
    if (deleted) break;
  }
  return deleted;
}

export async function listWorkflows(workspaceId) {
  const filePath = workflowsPath(workspaceId);
  return readJsonPath(filePath, []);
}

export async function getWorkflow(workflowId, workspaceId) {
  if (workspaceId) {
    const workflows = await listWorkflows(workspaceId);
    return workflows.find((w) => w.id === workflowId) || null;
  }
  // Search all workspaces
  const dataDir = getDataDir();
  const wsDir = join(dataDir, "workflows");
  const { readdirSync, existsSync } = await import("fs");
  if (!existsSync(wsDir)) return null;

  const dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const dir of dirs) {
    const workflows = await listWorkflows(dir);
    const found = workflows.find((w) => w.id === workflowId);
    if (found) return found;
  }
  return null;
}

export async function executeWorkflow(workflowId, context = {}) {
  const workflow = await getWorkflow(workflowId, context.workspaceId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  if (!workflow.enabled) throw new Error(`Workflow is disabled: ${workflowId}`);

  const runId = randomUUID();
  const startTime = Date.now();
  const variables = { ...workflow.variables, ...(context.variables || {}) };
  const stepOutputs = {};

  const interpolationCtx = {
    variables,
    trigger: { input: context.input || {}, triggeredBy: context.triggeredBy || "manual" },
    steps: stepOutputs,
  };

  const stepResults = [];
  let overallStatus = "completed";

  const stepsToExecute = workflow.steps || [];

  for (let i = 0; i < stepsToExecute.length; i++) {
    const step = stepsToExecute[i];
    const stepStart = Date.now();
    const stepResult = { stepId: step.id || `step-${i}`, name: step.name || step.type, status: "pending", output: null, duration: 0 };

    try {
      const config = interpolateDeep(step.config || {}, interpolationCtx);

      let output;
      switch (step.type) {
        case "chat":
          output = await executeChatStep(config, interpolationCtx);
          break;
        case "recipe":
          output = await executeRecipeStep(config, interpolationCtx);
          break;
        case "http":
          output = await executeHttpStep(config, interpolationCtx);
          break;
        case "condition": {
          const condResult = evaluateCondition(config.expression, interpolationCtx);
          output = { condition: condResult, branch: condResult ? "then" : "else" };
          // Find and execute the target step by id
          const targetStepId = condResult ? config.thenStep : config.elseStep;
          if (targetStepId) {
            const targetStep = stepsToExecute.find((s) => s.id === targetStepId);
            if (targetStep) {
              const targetConfig = interpolateDeep(targetStep.config || {}, interpolationCtx);
              let branchOutput;
              switch (targetStep.type) {
                case "chat": branchOutput = await executeChatStep(targetConfig, interpolationCtx); break;
                case "recipe": branchOutput = await executeRecipeStep(targetConfig, interpolationCtx); break;
                case "http": branchOutput = await executeHttpStep(targetConfig, interpolationCtx); break;
                case "transform": branchOutput = executeTransformStep(targetConfig, interpolationCtx); break;
                case "notify": branchOutput = executeNotifyStep(targetConfig, interpolationCtx); break;
                default: branchOutput = { error: `Unknown step type: ${targetStep.type}` };
              }
              output.branchOutput = branchOutput;
              stepOutputs[targetStepId] = branchOutput;
            }
          }
          break;
        }
        case "transform":
          output = executeTransformStep(config, interpolationCtx);
          break;
        case "notify":
          output = executeNotifyStep(config, interpolationCtx);
          break;
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }

      stepResult.status = "completed";
      stepResult.output = output;
      stepOutputs[step.id || `step-${i}`] = output;
    } catch (err) {
      stepResult.status = "failed";
      stepResult.output = { error: err.message };
      stepOutputs[step.id || `step-${i}`] = { error: err.message };

      const onError = step.onError || "stop";
      if (onError === "stop") {
        overallStatus = "failed";
        stepResult.duration = Date.now() - stepStart;
        stepResults.push(stepResult);
        break;
      }
      if (onError === "retry") {
        // One retry attempt
        try {
          const config = interpolateDeep(step.config || {}, interpolationCtx);
          let retryOutput;
          switch (step.type) {
            case "chat": retryOutput = await executeChatStep(config, interpolationCtx); break;
            case "recipe": retryOutput = await executeRecipeStep(config, interpolationCtx); break;
            case "http": retryOutput = await executeHttpStep(config, interpolationCtx); break;
            case "transform": retryOutput = executeTransformStep(config, interpolationCtx); break;
            case "notify": retryOutput = executeNotifyStep(config, interpolationCtx); break;
            default: throw new Error(`Unknown step type: ${step.type}`); // eslint-disable-line preserve-caught-error
          }
          stepResult.status = "completed";
          stepResult.output = retryOutput;
          stepOutputs[step.id || `step-${i}`] = retryOutput;
        } catch (retryErr) {
          stepResult.status = "failed";
          stepResult.output = { error: retryErr.message };
          overallStatus = "failed";
          stepResult.duration = Date.now() - stepStart;
          stepResults.push(stepResult);
          break;
        }
      }
      // onError === "continue" falls through
    }

    stepResult.duration = Date.now() - stepStart;
    stepResults.push(stepResult);
  }

  const run = {
    runId,
    workflowId,
    workspaceId: workflow.workspaceId,
    triggeredBy: context.triggeredBy || "manual",
    status: overallStatus,
    steps: stepResults,
    variables,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    duration: Date.now() - startTime,
  };

  // Persist run
  const filePath = runsPath(workflow.workspaceId);
  await withPathLock(filePath, async () => {
    const runs = await readJsonPath(filePath, []);
    runs.push(run);
    // Keep last 500 runs
    if (runs.length > 500) runs.splice(0, runs.length - 500);
    await writeJsonPath(filePath, runs);
  });

  return run;
}

export async function getWorkflowRun(runId, workspaceId) {
  if (workspaceId) {
    const filePath = runsPath(workspaceId);
    const runs = await readJsonPath(filePath, []);
    return runs.find((r) => r.runId === runId) || null;
  }
  // Search all workspaces
  const dataDir = getDataDir();
  const wsDir = join(dataDir, "workflows");
  const { readdirSync, existsSync } = await import("fs");
  if (!existsSync(wsDir)) return null;

  const dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const dir of dirs) {
    const filePath = runsPath(dir);
    const runs = await readJsonPath(filePath, []);
    const found = runs.find((r) => r.runId === runId);
    if (found) return found;
  }
  return null;
}

export async function listWorkflowRuns(workflowId, options = {}) {
  const { workspaceId, limit = 50, offset = 0 } = options;

  let allRuns = [];
  if (workspaceId) {
    const filePath = runsPath(workspaceId);
    allRuns = await readJsonPath(filePath, []);
  } else {
    const dataDir = getDataDir();
    const wsDir = join(dataDir, "workflows");
    const { readdirSync, existsSync } = await import("fs");
    if (!existsSync(wsDir)) return [];
    const dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const dir of dirs) {
      const filePath = runsPath(dir);
      const runs = await readJsonPath(filePath, []);
      allRuns.push(...runs);
    }
  }

  const filtered = workflowId ? allRuns.filter((r) => r.workflowId === workflowId) : allRuns;
  // Sort newest first
  filtered.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return filtered.slice(offset, offset + limit);
}
