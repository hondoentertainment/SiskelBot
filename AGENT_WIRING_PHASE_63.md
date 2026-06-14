# Phase 63 wiring (Code Generation vertical)

The 5 new route modules need to be added to `routes/index.js`.

## 1. Add the 5 imports

Add alongside the existing `import { mountXxxRoutes } from "./xxx.js";` block:

```js
import { mountRepoRagRoutes } from "./repo-rag.js";
import { mountPrReviewRoutes } from "./pr-review-agent.js";
import { mountTestGenRoutes } from "./test-gen.js";
import { mountRefactorRoutes } from "./refactor-agent.js";
import { mountMigrationRoutes } from "./migration-assistant.js";
```

## 2. Add the 5 entries to the `mountFunctions` array

Append (or insert in any reasonable location) inside the `const mountFunctions = [ ... ]` array:

```js
  mountRepoRagRoutes,
  mountPrReviewRoutes,
  mountTestGenRoutes,
  mountRefactorRoutes,
  mountMigrationRoutes,
```

## Endpoints exposed

After wiring, the following endpoints are mounted under both `/api/` and `/api/v1/`:

- **repo-rag** — `POST /repo-rag/index`, `GET /repo-rag/search`, `GET /repo-rag/stats`, `GET /repo-rag/repos`, `DELETE /repo-rag/repos/:repoId`
- **pr-review** — `POST /pr-review/review`, `GET /pr-review/reviews`, `GET /pr-review/reviews/:id`, `GET /pr-review/rules`
- **test-gen** — `POST /test-gen/analyze`, `POST /test-gen/generate`, `GET /test-gen/gaps`, `GET /test-gen/history`
- **refactor** — `POST /refactor/plan`, `GET /refactor/plans`, `GET /refactor/plans/:id/preview`, `POST /refactor/plans/:id/apply`, `GET /refactor/plans/:id`
- **migration** — `GET /migration/playbooks`, `POST /migration/playbooks`, `POST /migration/start`, `GET /migration/migrations/:id`, `POST /migration/migrations/:id/advance`, `GET /migration/migrations`

All endpoints require `adminAuth`.

## Storage paths created

- `data/repo-rag/{workspaceId}.json`
- `data/pr-review/{workspaceId}.json`
- `data/test-gen/{workspaceId}.json`
- `data/refactor/{workspaceId}.json`
- `data/migration/playbooks.json`
- `data/migration/{workspaceId}.json`
