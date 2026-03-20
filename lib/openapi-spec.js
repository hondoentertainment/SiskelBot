/** OpenAPI 3.0 spec for Bond API (Phase 23) */
const spec = {
  openapi: "3.0.3",
  info: {
    title: "Bond API",
    version: "1.0.0",
    description:
      "Bond streaming assistant API. Stable endpoints are under /api/v1/. " +
      "Chat completions follow the OpenAI spec at /v1/chat/completions.",
  },
  servers: [{ url: "/", description: "Relative to deployment origin" }],
  paths: {
    "/api/v1/context": {
      get: {
        summary: "List context items",
        operationId: "getContext",
        tags: ["context"],
        parameters: [{ name: "workspace", in: "query", schema: { type: "string" } }],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "List of context items" } },
      },
      post: {
        summary: "Add context item",
        operationId: "addContext",
        tags: ["context"],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Created context item" } },
      },
    },
    "/api/v1/recipes": {
      get: {
        summary: "List recipes",
        operationId: "listRecipes",
        tags: ["recipes"],
        parameters: [{ name: "workspace", in: "query", schema: { type: "string" } }],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "List of recipes" } },
      },
      post: {
        summary: "Create recipe",
        operationId: "createRecipe",
        tags: ["recipes"],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Created recipe" } },
      },
    },
    "/api/v1/conversations": {
      get: {
        summary: "List conversations",
        operationId: "listConversations",
        tags: ["conversations"],
        parameters: [{ name: "workspace", in: "query", schema: { type: "string" } }],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "List of conversations" } },
      },
      post: {
        summary: "Create conversation",
        operationId: "createConversation",
        tags: ["conversations"],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Created conversation" } },
      },
    },
    "/api/v1/workspaces": {
      get: {
        summary: "List workspaces",
        operationId: "listWorkspaces",
        tags: ["workspaces"],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "List of workspaces" } },
      },
      post: {
        summary: "Create workspace",
        operationId: "createWorkspace",
        tags: ["workspaces"],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Created workspace" } },
      },
    },
    "/api/v1/usage/summary": {
      get: {
        summary: "Usage summary",
        operationId: "getUsageSummary",
        tags: ["usage"],
        parameters: [
          { name: "days", in: "query", schema: { type: "integer" } },
          { name: "workspace", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Usage summary" } },
      },
    },
    "/api/v1/analytics/dashboard": {
      get: {
        summary: "Analytics dashboard",
        operationId: "getAnalyticsDashboard",
        tags: ["analytics"],
        parameters: [
          { name: "days", in: "query", schema: { type: "integer" } },
          { name: "workspace", in: "query", schema: { type: "string" } },
        ],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Analytics dashboard" } },
      },
    },
    "/api/v1/webhooks": {
      get: {
        summary: "List webhooks",
        operationId: "listWebhooks",
        tags: ["webhooks"],
        parameters: [{ name: "workspace", in: "query", schema: { type: "string" } }],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "List of webhooks" } },
      },
      post: {
        summary: "Add webhook",
        operationId: "addWebhook",
        tags: ["webhooks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "events"],
                properties: {
                  url: { type: "string" },
                  events: { type: "array", items: { type: "string" } },
                  secret: { type: "string" },
                  workspace: { type: "string" },
                },
              },
            },
          },
        },
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Created webhook" } },
      },
    },
    "/api/v1/schedules": {
      get: {
        summary: "List schedules",
        operationId: "listSchedules",
        tags: ["schedules"],
        parameters: [{ name: "workspace", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "List of schedules" } },
      },
      post: {
        summary: "Add or update schedule",
        operationId: "upsertSchedule",
        tags: ["schedules"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recipeId", "cron"],
                properties: {
                  recipeId: { type: "string" },
                  cron: { type: "string" },
                  timezone: { type: "string" },
                  enabled: { type: "boolean" },
                  workspace: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created or updated schedule" } },
      },
    },
    "/api/v1/plugins/actions": {
      get: {
        summary: "List plugin actions",
        operationId: "getPluginActions",
        tags: ["plugins"],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Array of action names" } },
      },
    },
    "/api/v1/embeddings": {
      post: {
        summary: "Compute embeddings (Phase 28)",
        operationId: "embed",
        tags: ["embeddings"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                oneOf: [
                  { required: ["text"], properties: { text: { type: "string" } } },
                  { required: ["texts"], properties: { texts: { type: "array", items: { type: "string" } } } },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "Returns { embedding: number[] } or { embeddings: number[][] }" },
          "400": { description: "Invalid body (text or texts required)" },
          "503": { description: "Embeddings unavailable (OPENAI_API_KEY not set)" },
        },
      },
    },
    "/api/v1/eval/sets": {
      get: {
        summary: "List eval sets (Phase 32)",
        operationId: "listEvalSets",
        tags: ["eval"],
        responses: { "200": { description: "Returns { sets: [{ id, name }] }" } },
        security: [{ bearerAuth: [] }],
      },
    },
    "/api/v1/eval/run": {
      post: {
        summary: "Run eval set (Phase 32)",
        operationId: "runEval",
        tags: ["eval"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  evalSetId: { type: "string" },
                  evalSet: { type: "object" },
                  model: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Returns { results, passed, total, durationMs }" } },
        security: [{ bearerAuth: [] }],
      },
    },
    "/api/v1/execute-step": {
      post: {
        summary: "Execute recipe step",
        operationId: "executeStep",
        tags: ["recipes"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["step", "allowExecution"],
                properties: {
                  step: { type: "object" },
                  allowExecution: { type: "boolean" },
                  workspace: { type: "string" },
                },
              },
            },
          },
        },
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Execution result" } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key",
        description: "User API key or deployment API key. Use Authorization: Bearer <key> or x-user-api-key header.",
      },
    },
  },
};

export default spec;
