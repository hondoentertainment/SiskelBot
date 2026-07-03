import fs from "fs";

const lines = fs.readFileSync("tmp-agent-tools-feature.js", "utf8").split("\n");
const defsLines = lines.slice(186, 371);
const casesLines = [
  ...lines.slice(828, 851),
  ...lines.slice(873, 949),
  ...lines.slice(964, 1157),
];

const out = `/**
 * Advanced meta-tools (chain, graph, subagent, scratchpad, etc.)
 * @module agent-tools-advanced
 */
import { executeChainToolsMeta } from "./tool-chaining.js";
import { getWorkspaceKnowledgeGraph } from "./knowledge-graph-store.js";
import { findRelatedReasoning, getReasoningChain } from "./reasoning-memory.js";
import { executeConsensus } from "./agent-consensus.js";
import { spawnSubagent } from "./spawn-subagent.js";
import { getScratchpad } from "./shared-scratchpad.js";
import { getAgentSession as getAgentSessionForScratchpad } from "./agent-session.js";
import { globalToolDiscovery } from "./tool-discovery.js";

export const ADVANCED_META_TOOL_DEFS = [
${defsLines.join("\n")}
];

export async function runAdvancedMetaTool(name, args, ctx, runTool) {
  const workspace = ctx.workspace || "default";
  switch (name) {
${casesLines.join("\n")}
    default:
      return null;
  }
}
`;

fs.writeFileSync("lib/agent-tools-advanced.js", out, "utf8");
console.log("bytes", out.length);
