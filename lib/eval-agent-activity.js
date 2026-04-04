/**
 * Agent / swarm activity checks shared by eval-runner and staging-trace replay.
 */

export function toolCallDisplayName(tc) {
  if (!tc || typeof tc !== "object") return "";
  if (typeof tc.name === "string" && tc.name) return tc.name;
  const fn = tc.function;
  if (fn && typeof fn.name === "string") return fn.name;
  return "";
}

export function collectToolNamesFromAgentActivity(activity) {
  const tcs = activity && Array.isArray(activity.toolCalls) ? activity.toolCalls : [];
  return tcs.map(toolCallDisplayName).filter(Boolean);
}

export function collectSwarmStepLabels(activity) {
  const steps = activity && Array.isArray(activity.swarmSteps) ? activity.swarmSteps : [];
  return steps
    .map((s) => {
      if (!s || typeof s !== "object") return "";
      if (typeof s.specialist === "string") return s.specialist;
      if (typeof s.name === "string") return s.name;
      return "";
    })
    .filter(Boolean);
}

/**
 * Agent outcome checks (SSE agent_activity from live agent/swarm runs or recorded staging traces).
 * @param {object} c
 * @param {object | null} agentActivity - payload from type=agent_activity
 */
export function checkAgentActivityCriteria(c, agentActivity) {
  const needsTools =
    c.expectedAgentActivityToolNames != null ||
    c.expectedAgentActivityToolSequence != null ||
    c.expectedMinAgentActivityToolCalls != null;
  const needsSwarm =
    c.expectedSwarmStepNames != null || c.expectedMinSwarmSteps != null;

  const needsStop = c.expectedStopReason != null || c.expectedStopReasonOneOf != null;
  if (!needsTools && !needsSwarm && !needsStop) {
    return { pass: true };
  }

  if (!agentActivity || typeof agentActivity !== "object") {
    return {
      pass: false,
      reason:
        "Expected agent_activity in SSE (run with agentMode/streaming) but none was returned",
    };
  }

  const names = collectToolNamesFromAgentActivity(agentActivity);

  if (c.expectedMinAgentActivityToolCalls != null) {
    const min = Number(c.expectedMinAgentActivityToolCalls);
    if (!Number.isFinite(min) || min < 0) {
      return { pass: false, reason: "expectedMinAgentActivityToolCalls must be a non-negative number" };
    }
    if (names.length < min) {
      return {
        pass: false,
        reason: `Expected at least ${min} tool calls in agent_activity, got ${names.length}`,
      };
    }
  }

  if (c.expectedAgentActivityToolNames != null) {
    const required = Array.isArray(c.expectedAgentActivityToolNames)
      ? c.expectedAgentActivityToolNames
      : [c.expectedAgentActivityToolNames];
    for (const req of required) {
      const n = String(req);
      if (!names.includes(n)) {
        return {
          pass: false,
          reason: `Expected tool name "${n}" in agent_activity.toolCalls; got: ${names.join(", ") || "(none)"}`,
        };
      }
    }
  }

  if (c.expectedAgentActivityToolSequence != null) {
    const seq = Array.isArray(c.expectedAgentActivityToolSequence)
      ? c.expectedAgentActivityToolSequence
      : [c.expectedAgentActivityToolSequence];
    const want = seq.map((x) => String(x));
    let from = 0;
    for (const w of want) {
      const idx = names.indexOf(w, from);
      if (idx === -1) {
        return {
          pass: false,
          reason: `Expected tool sequence ${JSON.stringify(want)}; actual order: ${JSON.stringify(names)}`,
        };
      }
      from = idx + 1;
    }
  }

  const swarmLabels = collectSwarmStepLabels(agentActivity);

  if (c.expectedMinSwarmSteps != null) {
    const min = Number(c.expectedMinSwarmSteps);
    if (!Number.isFinite(min) || min < 0) {
      return { pass: false, reason: "expectedMinSwarmSteps must be a non-negative number" };
    }
    if (swarmLabels.length < min) {
      return {
        pass: false,
        reason: `Expected at least ${min} swarm steps in agent_activity, got ${swarmLabels.length}`,
      };
    }
  }

  if (c.expectedSwarmStepNames != null) {
    const required = Array.isArray(c.expectedSwarmStepNames)
      ? c.expectedSwarmStepNames
      : [c.expectedSwarmStepNames];
    for (const req of required) {
      const n = String(req);
      if (!swarmLabels.includes(n)) {
        return {
          pass: false,
          reason: `Expected swarm step "${n}" in agent_activity.swarmSteps; got: ${swarmLabels.join(", ") || "(none)"}`,
        };
      }
    }
  }

  if (c.expectedStopReason != null) {
    const expected = String(c.expectedStopReason);
    const actual = String(agentActivity.stopReason || "");
    if (actual !== expected) {
      return {
        pass: false,
        reason: `Expected stopReason "${expected}" in agent_activity; got "${actual || "(none)"}"`,
      };
    }
  }
  if (c.expectedStopReasonOneOf != null) {
    const options = Array.isArray(c.expectedStopReasonOneOf)
      ? c.expectedStopReasonOneOf.map((x) => String(x))
      : [String(c.expectedStopReasonOneOf)];
    const actual = String(agentActivity.stopReason || "");
    if (!options.includes(actual)) {
      return {
        pass: false,
        reason: `Expected stopReason in ${JSON.stringify(options)}; got "${actual || "(none)"}"`,
      };
    }
  }

  return { pass: true };
}
