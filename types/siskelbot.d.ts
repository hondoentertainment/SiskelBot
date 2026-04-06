/**
 * Shared type definitions for SiskelBot.
 * Used by JSDoc annotations via @ts-check across the codebase.
 */

declare namespace SiskelBot {
  /** A chat message in the OpenAI-compatible format. */
  interface Message {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    tool_call_id?: string;
    tool_calls?: ToolCallRef[];
  }

  /** A tool call reference within an assistant message. */
  interface ToolCallRef {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }

  /** Parsed tool call used internally. */
  interface ToolCall {
    name: string;
    arguments: Record<string, any>;
  }

  /** Result returned from runTool. */
  interface ToolResult {
    content: string;
    ok?: boolean;
    _timeout?: boolean;
  }

  /** Context passed to agent tool execution. */
  interface AgentContext {
    allowExecution: boolean;
    projectDir?: string;
    vercelToken?: string;
    workspace: string;
    workspaceUserId: string;
    workspaceAllowedTools?: Set<string> | null;
  }

  /** An OpenAI-compatible tool definition. */
  interface ToolDefinition {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, any>;
        required?: string[];
      };
    };
  }

  /** A storage item (generic shape for context, recipes, conversations). */
  interface StorageItem {
    id: string;
    workspace?: string;
    createdAt?: string;
    updatedAt?: string;
    [key: string]: any;
  }

  /** Shape of the storage data file on disk or in KV. */
  interface StorageData {
    _version: number;
    items: StorageItem[];
  }

  /** Workspace metadata. */
  interface Workspace {
    id: string;
    name: string;
    userId: string;
    createdAt: string;
    type: "personal" | "team";
  }

  /** Consistent JSON error response. */
  interface ApiError {
    error: string;
    code: string;
    hint?: string;
    requestId?: string;
  }

  /** Resolved API key info from auth. */
  interface KeyInfo {
    userId: string;
    scopes: string[];
    keyId?: string;
  }

  /** Tool validation result. */
  interface ToolValidationResult {
    valid: boolean;
    errors: string[];
    repairHint: string;
  }

  /** Agent loop return value. */
  interface AgentLoopResult {
    content: string;
    iteration: number;
    toolCalls: ToolCallLogEntry[];
    runId: string;
    stopReason: string;
    citationWarning: boolean;
    trajectory: any;
  }

  /** An entry in the tool calls log. */
  interface ToolCallLogEntry {
    name: string;
    args: Record<string, any>;
    iteration: number;
    durationMs: number;
    ok: boolean;
    error?: boolean;
    validationError?: boolean;
  }

  /** Agent progress event emitted via onProgress. */
  interface AgentProgressEvent {
    type: "agent_progress";
    iteration: number;
    llmMs: number;
    toolsWallMs: number;
    tools: Array<{ name: string; durationMs: number; ok: boolean; validationError?: boolean }>;
  }

  /** Storage type literals. */
  type StorageType = "context" | "recipes" | "conversations";
}
