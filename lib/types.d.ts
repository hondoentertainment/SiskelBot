/**
 * Shared type definitions for SiskelBot lib modules.
 */

import type { Request, Response, NextFunction } from "express";

// ─── Express augmented types ───────────────────────────────────────

export interface SiskelRequest extends Request {
  userId?: string;
  apiKeyScopes?: string[];
  apiKeyId?: string;
  authenticatedViaDeploymentKey?: boolean;
  session?: { userId?: string } & Record<string, unknown>;
}

// ─── Storage record types ──────────────────────────────────────────

export interface StorageEnvelope {
  _version: number;
  items: StorageItem[];
}

export interface StorageItem {
  id: string;
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface Workspace {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  type: "personal" | "team";
}

/** Storage type discriminator: which JSON file to load. */
export type StorageType = "context" | "recipes" | "conversations";

// ─── Auth types ────────────────────────────────────────────────────

export interface KeyInfo {
  userId: string;
  scopes: string[];
  keyId?: string;
}

export interface KeyEntry {
  key: string;
  userId: string;
  scopes: string[];
}

// ─── Agent types ───────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCallLogEntry {
  name: string;
  args: Record<string, unknown>;
  iteration: number;
  durationMs?: number;
  ok?: boolean;
  error?: boolean;
  validationError?: boolean;
}

export interface ToolMetric {
  name: string;
  durationMs: number;
  ok: boolean;
  validationError?: boolean;
}

export interface AgentLoopResult {
  content: string;
  iteration: number;
  toolCalls: ToolCallLogEntry[];
  runId: string;
  stopReason: string;
  citationWarning: boolean;
  trajectory: unknown;
}

export interface AgentProgressEvent {
  type: "agent_progress";
  iteration: number;
  llmMs: number;
  toolsWallMs: number;
  tools: ToolMetric[];
}

export interface ToolContext {
  allowExecution: boolean;
  projectDir: string;
  vercelToken?: string;
  workspace: string;
  workspaceUserId?: string;
  workspaceAllowedTools?: Set<string> | null;
  workspaceAllowedToolNames?: string[];
}

export interface ProxyConfig {
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
}

export interface StreamOptions {
  presetRunId?: string;
  onProgress?: (event: AgentProgressEvent) => void;
}

// ─── Swarm types ───────────────────────────────────────────────────

export interface SwarmIntent {
  researcher: boolean;
  executor: boolean;
  mode?: string;
}

export interface SwarmSpecialistResolution {
  specialistNames: string[];
  parallelFanOut: boolean;
  rosterSource: "client" | "parallel" | "intent";
}

export interface SpecialistResult {
  specialist: string;
  content?: string;
  output?: string;
  success: boolean;
  latencyMs: number;
  error?: Error | null;
}

export interface SwarmDirectResult {
  aggregation: Array<{
    specialist: string;
    output: string;
    success: boolean;
    latencyMs: number;
    error?: string;
  }>;
  metrics: { agentCount: number; durationMs: number };
}

export interface SwarmResult {
  content: string;
  iteration: number;
  swarmSteps?: Array<{ specialist: string; success: boolean; latencyMs: number }>;
  synthesisDeferred?: { url: string; config: ProxyConfig; synthBody: object } | null;
  fallbackAggregate?: string;
}

export interface SwarmRunOptions {
  backendFetch?: typeof fetch;
  maxIterations?: number;
  allowRecipeExecution?: boolean;
}

export interface SpecialistLoopOptions {
  url: string;
  config: ProxyConfig;
  model: string;
  toolCtx: ToolContext;
  backendFetch: typeof fetch;
  maxIterations?: number;
  storageUserId?: string;
  workspace?: string;
  agentOptions?: Record<string, unknown>;
  swarmRunStartedMs?: number;
}
