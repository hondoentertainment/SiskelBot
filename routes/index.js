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
