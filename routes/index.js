/**
 * Route module index — mounts all extracted route modules.
 *
 * Each route module exports a function: mountXRoutes(app, deps)
 * where `deps` is an object containing shared middleware, helpers, and config
 * that the routes need (apiError, auth middleware, rate limiters, etc.).
 *
 * Usage (in server.js):
 *   import { mountAllRoutes } from "./routes/index.js";
 *   mountAllRoutes(app, deps);
 *
 * Route modules:
 *   auth.js          - /config, /auth/*
 *   chat.js          - /v1/chat/completions, /v1/agent/swarm, /v1/swarm
 *   tasks.js         - /v1/tasks/plan
 *   health.js        - /health/*, /metrics
 *   integrations.js  - /api/github/*, /api/vercel/*, /api/integrations/*
 *   usage.js         - /api/usage*, /api/analytics*
 *   knowledge.js     - /api/context*, /api/embeddings*, /api/knowledge*
 *   workspaces.js    - /api/workspaces*, templates, agent settings
 *   recipes.js       - /api/recipes*, /api/schedules*
 *   teams.js         - /api/teams/*
 *   admin.js         - /api/admin/*, /api/routing/*, /api/regions/*
 *   docs.js          - /api/docs*, /docs
 *   backup.js        - /api/backup*
 *   conversations.js - /api/conversations*
 *   plugins.js       - /api/plugins*, /api/marketplace*, /api/workspaces/:id/plugins
 *   webhooks.js      - /api/webhooks*, /api/ws-token, /api/ws-replay, /api/notifications*, /api/workspaces/:id/presence
 *   eval.js          - /api/eval*, /api/traces*, /api/agent/trajectory*
 *   execute.js       - /api/execute-step, /api/automations/validate
 *   multimodal.js    - /api/vision/describe, /api/documents/extract, /api/ocr
 *   federation.js    - /api/federation/*
 *   mcp.js           - /mcp, /mcp/sse
 *   slack-discord.js - /api/integrations/slack/*, /api/integrations/discord/*, /api/integrations/bots/*
 */

import mountAuthRoutes from "./auth.js";
import mountChatRoutes from "./chat.js";
import mountTasksRoutes from "./tasks.js";
import mountHealthRoutes from "./health.js";
import mountIntegrationsRoutes from "./integrations.js";
import mountUsageRoutes from "./usage.js";
import mountKnowledgeRoutes from "./knowledge.js";
import mountWorkspacesRoutes from "./workspaces.js";
import mountRecipesRoutes from "./recipes.js";
import mountTeamsRoutes from "./teams.js";
import mountAdminRoutes from "./admin.js";
import mountDocsRoutes from "./docs.js";
import { mountBackupRoutes } from "./backup.js";
import { mountConversationRoutes } from "./conversations.js";
import { mountPluginRoutes } from "./plugins.js";
import { mountWebhookRoutes } from "./webhooks.js";
import { mountEvalRoutes } from "./eval.js";
import { mountExecuteRoutes } from "./execute.js";
import mountMultimodalRoutes from "./multimodal.js";
import { mountFederationRoutes } from "./federation.js";
import { mountMcpRoutes } from "./mcp.js";
import { mountSlackDiscordRoutes } from "./slack-discord.js";

const mountFunctions = [
  mountAuthRoutes,
  mountChatRoutes,
  mountTasksRoutes,
  mountHealthRoutes,
  mountIntegrationsRoutes,
  mountUsageRoutes,
  mountKnowledgeRoutes,
  mountWorkspacesRoutes,
  mountRecipesRoutes,
  mountTeamsRoutes,
  mountAdminRoutes,
  mountDocsRoutes,
  mountBackupRoutes,
  mountConversationRoutes,
  mountPluginRoutes,
  mountWebhookRoutes,
  mountEvalRoutes,
  mountExecuteRoutes,
  mountMultimodalRoutes,
  mountFederationRoutes,
  mountMcpRoutes,
  mountSlackDiscordRoutes,
];

/**
 * Mount all extracted route modules on the Express app.
 * @param {import("express").Express} app
 * @param {object} deps - Shared middleware, helpers, config, and lib imports
 */
export function mountAllRoutes(app, deps) {
  for (const mount of mountFunctions) {
    mount(app, deps);
  }
}
