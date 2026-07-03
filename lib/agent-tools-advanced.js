/**
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
  {
    type: "function",
    function: {
      name: "chain_tools",
      description:
        "Execute a sequence of tools where each receives the previous tool's result. Use for multi-step operations that don't need LLM reasoning between steps. Reference prior output with {{tool.previous.output}} in args.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of tool calls. Each step can reference {{tool.previous.output}} in its args.",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "Tool name to invoke" },
                args: { type: "object", description: "Arguments for the tool", additionalProperties: true },
              },
              required: ["tool"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_tools",
      description:
        "Get tool recommendations for a given task based on past effectiveness learned by the tool discovery system. Returns up to five tools ranked by success rate and usage volume for the inferred task type.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Natural-language description of the task to find recommended tools for",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_graph",
      description:
        "Search the knowledge graph for entities and their relationships across documents. Use to find connections between concepts, people, technologies, and organizations mentioned in the knowledge base.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Entity name or keyword to search for" },
          type: {
            type: "string",
            description: "Filter by entity type: person, organization, concept, tool, technology, location, event, other",
          },
          entityId: {
            type: "string",
            description: "If provided, get neighbors of this entity instead of searching by name",
          },
          depth: {
            type: "number",
            description: "Traversal depth for neighbor lookup (default 1, max 3)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_reasoning",
      description:
        "Recall the agent's own past reasoning chains from earlier conversations in this workspace. Use when you want to check how a previous conclusion was reached, whether you've already answered a similar question, or to avoid repeating investigations. Provide a query to search past steps, or a conversationId to fetch a specific chain.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword query to search past reasoning (premise + inference + conclusion).",
          },
          conversationId: {
            type: "string",
            description: "If provided, return the full reasoning chain for this conversation instead of searching.",
          },
          limit: {
            type: "number",
            description: "Maximum number of related reasoning steps to return (default 10, max 50).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consensus_query",
      description:
        "Query multiple models for consensus on an answer. Runs the same prompt against several agents and aggregates the responses via majority vote (default), weighted vote, ranked choice, or LLM judge. Use when accuracy matters more than latency, e.g. factual lookups, controversial questions, or high-stakes decisions. Returns the consensus answer and a confidence score in [0,1].",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt or question to send to each agent" },
          minAgents: {
            type: "number",
            description: "Minimum number of agents that must respond successfully (quorum). Defaults to 2.",
          },
          strategy: {
            type: "string",
            description:
              "Aggregation strategy: 'majority_vote' (default), 'weighted', 'llm_judge', or 'ranked_choice'.",
          },
          models: {
            type: "array",
            description:
              "Optional list of model identifiers to use (one agent per model). If omitted, defaults to a small ensemble of the configured backend's available models.",
            items: { type: "string" },
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "Delegate a subtask to a child agent. The child runs its own tool-call loop with its own budget and returns a structured result. Use this when a task is large enough to benefit from decomposition.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Clear statement of what the child should accomplish" },
          profile: {
            type: "string",
            description: "Named profile: researcher, executor, synthesizer, code_writer, reviewer, or 'default'",
          },
          model: { type: "string", description: "Override model for child (optional, inherits parent if omitted)" },
          maxIterations: { type: "number", description: "Max iterations for child (default 10)" },
          toolAllowlist: {
            type: "array",
            items: { type: "string" },
            description: "Tools the child may use (empty = inherit parent's allowlist)",
          },
          context: {
            type: "string",
            description: "Additional context/instructions passed as a user message to the child",
          },
        },
        required: ["goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_scratchpad",
      description:
        "Write a key-value pair to the shared scratchpad for this agent session. Sibling subagents can read what you write. Use for sharing intermediate results, partial answers, or coordination state across agents in a swarm.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name to write (unique within the session scratchpad)" },
          value: { type: "string", description: "Value to store (JSON string or plain text)" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_scratchpad",
      description:
        "Read from the shared scratchpad for this agent session. If key is provided, returns that entry. If key is omitted, returns a list of all keys with previews. Use to see what sibling agents have written.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key to read. Omit to list all keys with previews." },
        },
      },
    },
  },
];

export async function runAdvancedMetaTool(name, args, ctx, runTool) {
  const workspace = ctx.workspace || "default";
  switch (name) {
    case "chain_tools": {
      const steps = args?.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        return { content: JSON.stringify({ ok: false, error: "steps array is required and must not be empty" }) };
      }
      const maxChainLen = Math.max(2, Number(process.env.AGENT_MAX_CHAIN_LENGTH) || 10);
      if (steps.length > maxChainLen) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Chain exceeds maximum length of ${maxChainLen} steps`,
            code: "CHAIN_TOO_LONG",
          }),
        };
      }
      // Bind runTool so chain steps go through full hook pipeline
      const chainResult = await executeChainToolsMeta(steps, ctx, (n, a, c) => runTool(n, a, c));
      return {
        content: JSON.stringify(chainResult),
        ok: chainResult.ok,
      };
    }

    case "recommend_tools": {
      const task = args?.task;
      if (typeof task !== "string" || !task.trim()) {
        return { content: JSON.stringify({ ok: false, error: "task is required" }), ok: false };
      }
      const recs = globalToolDiscovery.recommendToolsForTask(task.trim());
      return {
        content: JSON.stringify({
          ok: true,
          task: task.trim(),
          recommendations: recs,
          count: recs.length,
        }),
        ok: true,
      };
    }

    case "search_knowledge_graph": {
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const entityId = args?.entityId;

      // If entityId provided, do neighbor lookup
      if (typeof entityId === "string" && entityId.trim()) {
        const ent = graph.getEntity(entityId.trim());
        if (!ent) {
          return { content: JSON.stringify({ error: "Entity not found", entityId }) };
        }
        const depth = Math.max(1, Math.min(Number(args?.depth) || 1, 3));
        const neighbors = graph.getNeighbors(entityId.trim(), depth);
        return {
          content: JSON.stringify({
            entity: ent,
            neighbors: neighbors.entities.slice(0, 20),
            relations: neighbors.relations.slice(0, 30),
            depth,
          }),
        };
      }

      // Otherwise search by name/type
      const query = {};
      if (typeof args?.query === "string" && args.query.trim()) query.name = args.query.trim();
      if (typeof args?.type === "string" && args.type.trim()) query.type = args.type.trim();

      if (!query.name && !query.type) {
        const stats = graph.getStats();
        const topEntities = graph.getTopEntities(10);
        return {
          content: JSON.stringify({
            stats,
            topEntities: topEntities.map((e) => ({ name: e.entity.name, type: e.entity.type, id: e.entity.id, connections: e.connectionCount })),
          }),
        };
      }

      const entities = graph.findEntities(query).slice(0, 15);
      const entitySummaries = entities.map((e) => {
        const rels = graph.getRelations(e.id);
        return {
          id: e.id,
          name: e.name,
          type: e.type,
          properties: e.properties,
          relationCount: rels.length,
        };
      });

      return {
        content: JSON.stringify({
          entities: entitySummaries,
          count: entitySummaries.length,
          query,
        }),
      };
    }

    case "recall_reasoning": {
      const wsId = workspace;
      const convId = typeof args?.conversationId === "string" ? args.conversationId.trim() : "";
      const limit = Math.min(Math.max(1, Number(args?.limit) || 10), 50);

      if (convId) {
        const chain = await getReasoningChain(convId, wsId);
        const steps = (chain.steps || []).slice(0, limit).map((s) => ({
          id: s.id,
          turnIndex: s.turnIndex,
          premise: s.premise,
          inference: s.inference,
          conclusion: s.conclusion,
          confidence: s.confidence,
          toolsUsed: s.toolsUsed,
          createdAt: s.createdAt,
        }));
        return {
          content: JSON.stringify({
            ok: true,
            conversationId: chain.conversationId,
            steps,
            count: steps.length,
          }),
        };
      }

      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (!query) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Either query or conversationId is required",
          }),
        };
      }
      const related = await findRelatedReasoning(query, wsId, { limit });
      return {
        content: JSON.stringify({
          ok: true,
          query,
          results: related.map((r) => ({
            conversationId: r.conversationId,
            relevance: r.relevance,
            turnIndex: r.step.turnIndex,
            premise: r.step.premise,
            inference: r.step.inference,
            conclusion: r.step.conclusion,
            confidence: r.step.confidence,
            toolsUsed: r.step.toolsUsed,
          })),
          count: related.length,
        }),
      };
    }

    case "consensus_query": {
      const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return { content: JSON.stringify({ ok: false, error: "prompt is required" }) };
      }
      const minAgents = Number.isFinite(args?.minAgents) ? Math.max(1, Number(args.minAgents)) : 2;
      const strategy = typeof args?.strategy === "string" ? args.strategy : "majority_vote";
      const requestedModels = Array.isArray(args?.models)
        ? args.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
        : [];
      const defaultModels = ["default", "default", "default"];
      const models = requestedModels.length >= 2 ? requestedModels : defaultModels;
      const agents = models.map((m, i) => ({ agentId: `${m}#${i}`, model: m }));
      try {
        const run = await executeConsensus(prompt, {
          agents,
          strategy,
          quorum: minAgents,
          backendFetch: ctx.backendFetch,
          buildProxyConfig: ctx.buildProxyConfig,
        });
        return {
          content: JSON.stringify({
            ok: !run.error,
            id: run.id,
            consensus: run.consensus,
            confidence: run.confidence,
            agreement: run.agreement,
            strategy: run.strategy,
            quorumMet: run.quorumMet,
            error: run.error,
            agentCount: Array.isArray(run.responses) ? run.responses.length : 0,
          }),
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
      }
    }

    case "spawn_subagent": {
      const goal = args?.goal;
      if (typeof goal !== "string" || !goal.trim()) {
        return { content: JSON.stringify({ ok: false, error: "goal is required" }), ok: false };
      }
      const depth = Number(ctx.depth) || 0;
      const result = await spawnSubagent({
        goal: goal.trim(),
        profile: typeof args?.profile === "string" ? args.profile : "default",
        model: typeof args?.model === "string" ? args.model : undefined,
        maxIterations: Number.isFinite(args?.maxIterations) ? args.maxIterations : 10,
        toolAllowlist: Array.isArray(args?.toolAllowlist) ? args.toolAllowlist : [],
        context: typeof args?.context === "string" ? args.context : undefined,
        parentRunId: ctx.runId,
        parentSessionId: ctx.agentSessionId,
        workspace,
        userId: ctx.workspaceUserId || "anonymous",
        depth,
        parentTools: ctx.currentTools,
        parentModel: ctx.currentModel,
        runAgentLoop: ctx.runAgentLoop,
        backendFetch: ctx.backendFetch,
        buildProxyConfig: ctx.buildProxyConfig,
      });
      return { content: JSON.stringify(result), ok: result.ok };
    }

    case "write_scratchpad": {
      const key = args?.key;
      if (typeof key !== "string" || !key.trim()) {
        return { content: JSON.stringify({ ok: false, error: "key is required" }), ok: false };
      }
      const value = args?.value;
      if (value === undefined || value === null) {
        return { content: JSON.stringify({ ok: false, error: "value is required" }), ok: false };
      }
      // Resolve parentSessionId: prefer explicit parentSessionId on ctx,
      // otherwise look up via session hierarchy, fall back to own sessionId.
      let scratchpadScope = ctx.parentSessionId || null;
      if (!scratchpadScope && ctx.agentSessionId) {
        try {
          const sess = await getAgentSessionForScratchpad(ctx.agentSessionId);
          if (sess && sess.parentSessionId) {
            scratchpadScope = sess.parentSessionId;
          } else {
            scratchpadScope = ctx.agentSessionId;
          }
        } catch {
          scratchpadScope = ctx.agentSessionId;
        }
      }
      if (!scratchpadScope) {
        return { content: JSON.stringify({ ok: false, error: "No session context available for scratchpad", code: "NO_SESSION" }), ok: false };
      }
      try {
        const pad = getScratchpad(scratchpadScope);
        pad.write(key.trim(), value, { author: ctx.agentSessionId || null });
        return { content: JSON.stringify({ ok: true, key: key.trim() }), ok: true };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: err.message, code: err.code || "SCRATCHPAD_ERROR" }), ok: false };
      }
    }

    case "read_scratchpad": {
      const key = typeof args?.key === "string" ? args.key.trim() : "";
      // Resolve parentSessionId same as write_scratchpad
      let scratchpadScope = ctx.parentSessionId || null;
      if (!scratchpadScope && ctx.agentSessionId) {
        try {
          const sess = await getAgentSessionForScratchpad(ctx.agentSessionId);
          if (sess && sess.parentSessionId) {
            scratchpadScope = sess.parentSessionId;
          } else {
            scratchpadScope = ctx.agentSessionId;
          }
        } catch {
          scratchpadScope = ctx.agentSessionId;
        }
      }
      if (!scratchpadScope) {
        return { content: JSON.stringify({ ok: false, error: "No session context available for scratchpad", code: "NO_SESSION" }), ok: false };
      }
      try {
        const pad = getScratchpad(scratchpadScope);
        if (key) {
          const entry = pad.read(key);
          if (!entry) {
            return { content: JSON.stringify({ ok: true, value: null, key }), ok: true };
          }
          return { content: JSON.stringify({ ok: true, value: entry.value, author: entry.author, updatedAt: entry.updatedAt }), ok: true };
        }
        // List mode
        const entries = pad.list();
        return { content: JSON.stringify({ ok: true, entries, count: entries.length }), ok: true };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: err.message, code: err.code || "SCRATCHPAD_ERROR" }), ok: false };
      }
    }
    default:
      return null;
  }
}
