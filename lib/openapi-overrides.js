/**
 * Hand-written OpenAPI overrides for endpoints where the generator
 * cannot infer request/response schemas automatically.
 *
 * Keyed by path (as registered). Merged into the auto-generated spec
 * by scripts/generate-openapi.mjs.
 */
export default {
  "/v1/chat/completions": {
    post: {
      summary: "Chat completions (streaming)",
      description:
        "Proxies chat completions to the configured backend (Ollama, vLLM, or OpenAI). " +
        "Supports streaming SSE responses, agent mode (tool-call loop), and swarm mode (multi-agent orchestration).",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["messages"],
              properties: {
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["role", "content"],
                    properties: {
                      role: {
                        type: "string",
                        enum: ["system", "user", "assistant", "tool"],
                      },
                      content: { type: "string" },
                    },
                  },
                  description: "Chat messages following the OpenAI messages format.",
                },
                model: {
                  type: "string",
                  description: "Model name. Defaults to the first model preset for the active backend.",
                },
                stream: {
                  type: "boolean",
                  default: true,
                  description: "Enable streaming SSE response.",
                },
                temperature: { type: "number", default: 0.7 },
                top_p: { type: "number", default: 0.95 },
                max_tokens: { type: "integer", default: 512 },
                agentMode: {
                  type: "boolean",
                  default: false,
                  description: "Enable agent mode (tool-call loop until text response).",
                },
                swarmMode: {
                  type: "boolean",
                  default: false,
                  description: "Enable swarm mode (multi-agent orchestration). Requires agentMode=true and ENABLE_AGENT_SWARM=1.",
                },
                agentOptions: {
                  type: "object",
                  properties: {
                    workspace: { type: "string", default: "default" },
                    maxIterations: { type: "integer" },
                  },
                },
                tools: {
                  type: "array",
                  items: { type: "object" },
                  description: "Optional tool definitions. Intersected with server allowlist.",
                },
                tool_choice: {
                  type: "string",
                  default: "auto",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Streaming SSE response with chat completion chunks.",
          content: {
            "text/event-stream": {
              schema: { type: "string" },
            },
          },
        },
        "429": { description: "Rate limited or quota exceeded." },
        "502": { description: "Backend unreachable." },
        "503": { description: "Circuit breaker open — backend temporarily unavailable." },
      },
    },
  },

  "/v1/tasks/plan": {
    post: {
      summary: "Generate a structured task plan",
      description:
        "Sends messages to the LLM with a task-planning system prompt and returns a validated JSON task plan.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["messages"],
              properties: {
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      role: { type: "string" },
                      content: { type: "string" },
                    },
                  },
                  description: "Chat messages describing the goal.",
                },
                model: {
                  type: "string",
                  description: "Model to use for planning.",
                },
                workspace: {
                  type: "string",
                  description: "Workspace scope for the plan event.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Structured task plan.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  plan: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["task"] },
                      name: { type: "string" },
                      steps: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            action: { type: "string" },
                            payload: { type: "object" },
                          },
                        },
                      },
                      requiresApproval: { type: "boolean" },
                    },
                  },
                  raw: { type: "string" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid body or LLM response could not be parsed." },
        "502": { description: "Backend unreachable." },
      },
    },
  },

  "/config": {
    get: {
      summary: "Client configuration",
      description:
        "Returns the current server configuration for the frontend client, including backend type, model presets, feature flags, and auth requirements.",
      responses: {
        "200": {
          description: "Server configuration object.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  backend: {
                    type: "string",
                    enum: ["ollama", "vllm", "openai"],
                    description: "Active backend provider.",
                  },
                  modelPresets: {
                    type: "array",
                    items: { type: "string" },
                    description: "Available model names for the active backend.",
                  },
                  modelPlaceholder: { type: "string" },
                  requiresApiKey: { type: "boolean" },
                  isProduction: { type: "boolean" },
                  defaultGenerationConfig: {
                    type: "object",
                    properties: {
                      temperature: { type: "number" },
                      top_p: { type: "number" },
                      max_tokens: { type: "integer" },
                    },
                  },
                  monitoringEnabled: { type: "boolean" },
                  swarmEnabled: { type: "boolean" },
                  authRequired: { type: "boolean" },
                  oauthProviders: {
                    type: "object",
                    properties: {
                      github: { type: "boolean" },
                      google: { type: "boolean" },
                    },
                  },
                  storageBackend: {
                    type: "string",
                    enum: ["json", "sqlite", "postgres"],
                  },
                  quotaEnabled: { type: "boolean" },
                  realtimeEnabled: { type: "boolean" },
                  agentEnabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },

  "/health/ready": {
    get: {
      summary: "Readiness probe",
      description:
        "Checks that storage is accessible and the active backend is reachable. Returns 503 if not ready.",
      responses: {
        "200": {
          description: "Server is ready.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean", example: true },
                  status: { type: "string", enum: ["ready"] },
                  backend: { type: "string" },
                },
              },
            },
          },
        },
        "503": {
          description: "Server is not ready.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean", example: false },
                  status: { type: "string", enum: ["not_ready"] },
                  reason: {
                    type: "string",
                    enum: ["storage_unavailable", "backend_unreachable", "health_check_failed"],
                  },
                  backend: { type: "string" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },

  "/health/live": {
    get: {
      summary: "Liveness probe",
      description: "Simple liveness check. Always returns 200 if the process is running.",
      responses: {
        "200": {
          description: "Process is alive.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean", example: true },
                  status: { type: "string", enum: ["alive"] },
                },
              },
            },
          },
        },
      },
    },
  },

  "/health": {
    get: {
      summary: "Health check with backend probe",
      description:
        "Probes all configured backends and returns reachability, latency, and cache status.",
      responses: {
        "200": {
          description: "Health status.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  backend: { type: "string" },
                  reachable: { type: "boolean" },
                  latencyMs: { type: "integer", nullable: true },
                  lastChecked: { type: "string", format: "date-time" },
                  cached: { type: "boolean" },
                  backends: { type: "object" },
                },
              },
            },
          },
        },
        "503": { description: "Health check failed." },
      },
    },
  },
};
