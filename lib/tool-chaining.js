// @ts-check
/**
 * Tool chain execution: execute multiple tools in a single turn without
 * LLM roundtrips. Supports sequential chains (output piped forward) and
 * parallel independent calls.
 * @module tool-chaining
 */

/**
 * Pattern used by the LLM to reference a previous tool's output inside
 * arguments.  Supports:
 *   {{tool.0.output}}        – output of step index 0
 *   {{tool.previous.output}} – output of the immediately preceding step
 */
const REF_PATTERN = /\{\{tool\.(previous|\d+)\.output\}\}/g;

/**
 * Scan a value (string or nested object/array) for tool-output references.
 * Returns a Set of referenced indices (numeric) or the string "previous".
 * @param {unknown} val
 * @returns {Set<string>}
 */
function findRefs(val) {
  const refs = new Set();
  if (typeof val === "string") {
    let m;
    REF_PATTERN.lastIndex = 0;
    while ((m = REF_PATTERN.exec(val)) !== null) {
      refs.add(m[1]);
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      for (const r of findRefs(item)) refs.add(r);
    }
  } else if (val && typeof val === "object") {
    for (const v of Object.values(val)) {
      for (const r of findRefs(v)) refs.add(r);
    }
  }
  return refs;
}

/**
 * Replace reference placeholders in a value with actual outputs.
 * @param {unknown} val
 * @param {Map<number, string>} outputs - index -> serialized output
 * @param {number} currentIndex
 * @returns {unknown}
 */
function resolveRefs(val, outputs, currentIndex) {
  if (typeof val === "string") {
    return val.replace(REF_PATTERN, (_match, ref) => {
      const idx = ref === "previous" ? currentIndex - 1 : Number(ref);
      return outputs.get(idx) ?? "";
    });
  }
  if (Array.isArray(val)) {
    return val.map((item) => resolveRefs(item, outputs, currentIndex));
  }
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = resolveRefs(v, outputs, currentIndex);
    }
    return out;
  }
  return val;
}

/**
 * Analyse an ordered array of tool calls for data dependencies.
 *
 * A call is part of a chain when its arguments contain `{{tool.N.output}}`
 * or `{{tool.previous.output}}`.  Calls without references to earlier calls
 * are independent and can run in parallel.
 *
 * @param {Array<{ name: string; args: Record<string, any> }>} toolCalls
 * @returns {{ chains: Array<Array<{ index: number; name: string; args: Record<string, any> }>>; parallel: Array<{ index: number; name: string; args: Record<string, any> }> }}
 */
export function detectChain(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { chains: [], parallel: [] };
  }

  // Build a dependency graph: for each call, which earlier indices it depends on.
  const deps = new Map(); // index -> Set<number>
  for (let i = 0; i < toolCalls.length; i++) {
    const refs = findRefs(toolCalls[i].args);
    const depSet = new Set();
    for (const ref of refs) {
      if (ref === "previous") {
        if (i > 0) depSet.add(i - 1);
      } else {
        const n = Number(ref);
        if (Number.isInteger(n) && n >= 0 && n < i) depSet.add(n);
      }
    }
    deps.set(i, depSet);
  }

  // Partition into: nodes with no dependents that nobody depends on (parallel),
  // and chains (connected sequences).
  const hasDeps = new Set();
  const isDependedOn = new Set();
  for (const [idx, d] of deps) {
    if (d.size > 0) {
      hasDeps.add(idx);
      for (const dep of d) isDependedOn.add(dep);
    }
  }

  const inChain = new Set([...hasDeps, ...isDependedOn]);
  const parallel = [];
  for (let i = 0; i < toolCalls.length; i++) {
    if (!inChain.has(i)) {
      parallel.push({ index: i, name: toolCalls[i].name, args: toolCalls[i].args });
    }
  }

  // Build chains by following dependency links.  A chain is a maximal
  // ordered sequence where each node depends on the previous.
  const visited = new Set();
  const chains = [];

  // Find chain roots: nodes in inChain that have no deps (or deps outside inChain).
  const roots = [...inChain].filter((i) => {
    const d = deps.get(i);
    return !d || d.size === 0;
  }).sort((a, b) => a - b);

  for (const root of roots) {
    if (visited.has(root)) continue;
    const chain = [{ index: root, name: toolCalls[root].name, args: toolCalls[root].args }];
    visited.add(root);

    let current = root;
    // Find next node that depends on current.
    while (true) {
      let next = -1;
      for (const idx of inChain) {
        if (visited.has(idx)) continue;
        const d = deps.get(idx);
        if (d && d.has(current)) {
          next = idx;
          break;
        }
      }
      if (next === -1) break;
      chain.push({ index: next, name: toolCalls[next].name, args: toolCalls[next].args });
      visited.add(next);
      current = next;
    }

    if (chain.length > 0) chains.push(chain);
  }

  // Catch any remaining unvisited chain members.
  for (const idx of inChain) {
    if (!visited.has(idx)) {
      chains.push([{ index: idx, name: toolCalls[idx].name, args: toolCalls[idx].args }]);
    }
  }

  return { chains, parallel };
}

/**
 * Execute a chain of tools sequentially, piping each output into the next
 * call's argument placeholders.
 *
 * @param {Array<{ index: number; name: string; args: Record<string, any> }>} chain
 * @param {object} toolCtx
 * @param {(name: string, args: Record<string, any>, ctx: object) => Promise<{ content: string; ok?: boolean }>} runTool
 * @returns {Promise<Array<{ name: string; args: Record<string, any>; result: string; durationMs: number; ok: boolean; error?: boolean }>>}
 */
export async function executeChain(chain, toolCtx, runTool) {
  const outputs = new Map(); // index -> output string
  const results = [];

  for (const step of chain) {
    const resolvedArgs = /** @type {Record<string, any>} */ (resolveRefs(step.args, outputs, step.index));
    const t0 = Date.now();
    try {
      const result = await runTool(step.name, resolvedArgs, toolCtx);
      const durationMs = Date.now() - t0;
      const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      outputs.set(step.index, content);
      results.push({
        name: step.name,
        args: resolvedArgs,
        result: content,
        durationMs,
        ok: result.ok !== false,
      });
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorMsg = JSON.stringify({ ok: false, error: String(err?.message || err) });
      results.push({
        name: step.name,
        args: resolvedArgs,
        result: errorMsg,
        durationMs,
        ok: false,
        error: true,
      });
      // Stop chain on error: remaining steps depend on this output.
      break;
    }
  }

  return results;
}

/**
 * Execute independent tool calls in parallel via Promise.all.
 *
 * @param {Array<{ index: number; name: string; args: Record<string, any> }>} calls
 * @param {object} toolCtx
 * @param {(name: string, args: Record<string, any>, ctx: object) => Promise<{ content: string; ok?: boolean }>} runTool
 * @returns {Promise<Array<{ name: string; args: Record<string, any>; result: string; durationMs: number; ok: boolean; error?: boolean }>>}
 */
export async function executeParallel(calls, toolCtx, runTool) {
  const results = await Promise.all(
    calls.map(async (call) => {
      const t0 = Date.now();
      try {
        const result = await runTool(call.name, call.args, toolCtx);
        const durationMs = Date.now() - t0;
        const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return {
          name: call.name,
          args: call.args,
          result: content,
          durationMs,
          ok: result.ok !== false,
        };
      } catch (err) {
        const durationMs = Date.now() - t0;
        return {
          name: call.name,
          args: call.args,
          result: JSON.stringify({ ok: false, error: String(err?.message || err) }),
          durationMs,
          ok: false,
          error: true,
        };
      }
    })
  );
  return results;
}

/**
 * Build an execution plan from a flat list of tool calls.  The plan groups
 * calls into ordered steps: each step has a `parallel` array (independent
 * calls) and a `sequential` array (chains that must execute in order).
 *
 * @param {Array<{ name: string; args: Record<string, any> }>} toolCalls
 * @returns {{ steps: Array<{ parallel: Array<{ index: number; name: string; args: Record<string, any> }>; sequential: Array<Array<{ index: number; name: string; args: Record<string, any> }>> }> }}
 */
export function buildChainPlan(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { steps: [] };
  }
  const { chains, parallel } = detectChain(toolCalls);
  return {
    steps: [{ parallel, sequential: chains }],
  };
}

/**
 * Execute a full chain plan: run parallel calls and sequential chains
 * concurrently (chains run their internal steps in sequence).
 *
 * @param {{ steps: Array<{ parallel: Array<{ index: number; name: string; args: Record<string, any> }>; sequential: Array<Array<{ index: number; name: string; args: Record<string, any> }>> }> }} plan
 * @param {object} toolCtx
 * @param {(name: string, args: Record<string, any>, ctx: object) => Promise<{ content: string; ok?: boolean }>} runTool
 * @returns {Promise<Array<{ name: string; args: Record<string, any>; result: string; durationMs: number; ok: boolean; error?: boolean }>>}
 */
export async function executePlan(plan, toolCtx, runTool) {
  const allResults = [];
  for (const step of plan.steps) {
    const promises = [];
    if (step.parallel.length > 0) {
      promises.push(executeParallel(step.parallel, toolCtx, runTool));
    }
    for (const chain of step.sequential) {
      promises.push(executeChain(chain, toolCtx, runTool));
    }
    const settled = await Promise.all(promises);
    for (const batch of settled) {
      allResults.push(...batch);
    }
  }
  return allResults;
}

/**
 * Execute the chain_tools meta-tool: a user-specified sequence of tool
 * calls where each receives the previous result.
 *
 * @param {Array<{ tool: string; args?: Record<string, any> }>} steps
 * @param {object} toolCtx
 * @param {(name: string, args: Record<string, any>, ctx: object) => Promise<{ content: string; ok?: boolean }>} runTool
 * @returns {Promise<{ ok: boolean; results: Array<{ tool: string; result: string; durationMs: number; ok: boolean }> }>}
 */
export async function executeChainToolsMeta(steps, toolCtx, runTool) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, results: [] };
  }

  const results = [];
  let previousOutput = "";

  for (const step of steps) {
    const name = step.tool;
    const rawArgs = step.args && typeof step.args === "object" ? { ...step.args } : {};

    // Inject previous output: replace {{tool.previous.output}} in all string values
    const resolvedArgs = /** @type {Record<string, any>} */ (
      resolveRefs(rawArgs, new Map([[results.length - 1, previousOutput]]), results.length)
    );

    const t0 = Date.now();
    try {
      const result = await runTool(name, resolvedArgs, toolCtx);
      const durationMs = Date.now() - t0;
      const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      previousOutput = content;
      results.push({ tool: name, result: content, durationMs, ok: result.ok !== false });
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorContent = JSON.stringify({ ok: false, error: String(err?.message || err) });
      results.push({ tool: name, result: errorContent, durationMs, ok: false });
      return { ok: false, results };
    }
  }

  return { ok: true, results };
}
