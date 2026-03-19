# SiskelBot Test Plan

Comprehensive test plan for SiskelBot (Phases 1–18). Use `npm test` to run all automated tests.

---

## 1. Test Categories

| Category | Scope | Automation | Tool |
|----------|-------|-------------|------|
| **Unit** | lib modules (auth, storage, scheduler, usage-tracker) | Yes | `node --test` |
| **Integration** | API endpoints via supertest | Yes | `node --test` |
| **E2E** | Full client flows, browser | Documented steps | Manual / Playwright (future) |
| **Manual** | UX, integrations, external services | Checkbox checklist | Human |

---

## 2. Per-Phase Test Scenarios

### Phase 1: Streaming Proxy
- [ ] GET /config returns backend, model presets, defaultGenerationConfig
- [ ] POST /v1/chat/completions streams when backend reachable
- [ ] API_KEY auth: 401 when key set and missing/invalid
- [ ] Rate limit returns 429 with RATE_LIMITED
- [ ] Backend unreachable returns 502 BACKEND_UNREACHABLE

### Phase 2: Templates & Profiles
- [ ] templates.defaults.json has required structure (coding, deployment, research, content, ops)
- [ ] Profiles array has Coding, Quick ops, Detailed research
- [ ] Client merges defaults with localStorage user templates

### Phase 3: Task Planning
- [ ] POST /v1/tasks/plan returns 400 when messages empty or not array
- [ ] Returns 400 PARSE_ERROR when LLM returns invalid JSON
- [ ] Returns 400 VALIDATION_ERROR when plan schema invalid (type, steps)
- [ ] Returns 200 with plan when valid LLM output
- [ ] Requires API_KEY when API_KEY env set

### Phase 4: Integrations Hub
- [ ] GET /api/integrations/status returns { github, vercel } booleans
- [ ] github: true when GITHUB_TOKEN set, false otherwise
- [ ] vercel: true when VERCEL_TOKEN set, false otherwise
- [ ] GET /api/github/repos returns 503 when GITHUB_TOKEN missing
- [ ] GET /api/vercel/deployments returns 503 when VERCEL_TOKEN missing
- [ ] Invalid owner/repo returns 400 INVALID_INPUT

### Phase 5: Knowledge System
- [ ] POST /api/knowledge/index requires text; 400 when missing
- [ ] Enforces max document size (413 DOC_TOO_LARGE)
- [ ] GET /api/knowledge/search with query returns results/empty
- [ ] GET /api/knowledge/list returns documents for workspace

### Phase 6: Automation Recipes (validate)
- [ ] POST /api/automations/validate returns { valid, errors } for recipe
- [ ] Invalid recipe (missing name, invalid steps) returns errors

### Phase 7: Monitoring
- [ ] GET /api/monitoring/status returns 503 when ENABLE_MONITORING not set
- [ ] GET /api/status/report returns health + integrations
- [ ] Health cache: same lastChecked within TTL; ?refresh=1 bypasses

### Phase 8: Multimodal
- [ ] POST /api/vision/describe requires image (base64 or multipart)
- [ ] POST /api/documents/extract requires file multipart
- [ ] POST /api/ocr returns 501 NOT_IMPLEMENTED

### Phase 9: Execute Step
- [ ] POST /api/execute-step returns 503 when ALLOW_RECIPE_STEP_EXECUTION not 1
- [ ] Returns 403 when allowExecution false
- [ ] Returns 400 when step/action missing
- [ ] Mock: returns 200 when step executes successfully

### Phase 10: Storage (context, recipes, conversations)
- [ ] POST /api/context requires title; 400 when missing
- [ ] GET/PUT/DELETE /api/context/:id return 404 for unknown id
- [ ] POST /api/recipes requires name; 400 when missing
- [ ] POST /api/context/sync merges items, returns merged list
- [ ] POST /api/recipes/sync merges items
- [ ] POST /api/conversations creates conversation with optional id

### Phase 13: Usage
- [ ] GET /api/usage/summary returns totalRequests, byModel, byDay
- [ ] days query param clamped 1–90
- [ ] recordUsage persists and getSummary includes new entries

### Phase 14: Workspaces & Auth
- [ ] GET /api/workspaces returns 401 when auth configured and no key
- [ ] GET /api/workspaces returns items when auth not configured (anonymous)
- [ ] POST /api/workspaces creates workspace with name
- [ ] userAuth: Bearer token and x-user-api-key supported
- [ ] isAuthConfigured reflects USER_API_KEYS / users.json

### Phase 15: Agent Mode
- [ ] agentMode + tools triggers tool loop (mock LLM)
- [ ] X-Agent-Iteration header present
- [ ] Max iterations respected when LLM keeps tool_calling

### Phase 16: Schedules
- [ ] GET /api/schedules returns list (empty or with items)
- [ ] POST /api/schedules requires recipeId + cron; 404 when recipe not found
- [ ] DELETE /api/schedules/:recipeId returns 204 or 404
- [ ] POST /api/schedules/run-now/:recipeId requires apiKeyAuth when API_KEY set
- [ ] GET /api/cron returns 401 when CRON_SECRET set and missing

### Phase 17: Plugins
- [ ] GET /api/plugins/actions returns built-in actions (build, deploy, copy)
- [ ] userAuth: 401 when auth configured and no key

### Phase 18: (If applicable)
- [ ] Document Phase 18 scope when defined

---

## 3. API Endpoint Coverage Matrix

| Method | Endpoint | Unit | Integration | Notes |
|--------|----------|------|-------------|-------|
| GET | / | ✓ | ✓ | Serves chat shell |
| GET | /config | ✓ | ✓ | |
| GET | /health | ✓ | ✓ | Cache, refresh |
| POST | /v1/chat/completions | — | Partial | Mock backend |
| POST | /v1/tasks/plan | ✓ | ✓ | Mock LLM |
| GET | /api/integrations/status | ✓ | ✓ | |
| GET | /api/github/repos | ✓ | ✓ | 503 when no token |
| GET | /api/github/repo/:owner/:repo | ✓ | ✓ | Validation |
| GET | /api/github/issues/:owner/:repo | — | ✓ | |
| GET | /api/vercel/deployments | ✓ | ✓ | 503 when no token |
| GET | /api/vercel/projects | — | ✓ | |
| POST | /api/knowledge/index | ✓ | ✓ | |
| GET | /api/knowledge/search | ✓ | ✓ | |
| GET | /api/knowledge/list | ✓ | ✓ | |
| GET | /api/usage/summary | ✓ | ✓ | |
| GET | /api/monitoring/status | ✓ | ✓ | |
| GET | /api/status/report | ✓ | ✓ | |
| GET | /api/workspaces | ✓ | ✓ | Auth |
| POST | /api/workspaces | ✓ | ✓ | Auth |
| GET | /api/context | ✓ | ✓ | |
| POST | /api/context | ✓ | ✓ | |
| GET/PUT/DELETE | /api/context/:id | ✓ | ✓ | |
| POST | /api/context/sync | ✓ | ✓ | |
| GET/POST/PUT/DELETE | /api/recipes | ✓ | ✓ | |
| POST | /api/recipes/sync | ✓ | ✓ | |
| GET/POST/DELETE | /api/schedules | ✓ | ✓ | |
| POST | /api/schedules/run-now/:id | ✓ | ✓ | |
| GET | /api/cron | ✓ | ✓ | CRON_SECRET |
| GET/POST/PUT/DELETE | /api/conversations | ✓ | ✓ | |
| POST | /api/automations/validate | ✓ | ✓ | |
| GET | /api/plugins/actions | ✓ | ✓ | |
| POST | /api/execute-step | ✓ | ✓ | Mock |
| POST | /api/vision/describe | — | Partial | OpenAI key |
| POST | /api/documents/extract | — | ✓ | PDF/text |
| POST | /api/ocr | ✓ | ✓ | 501 |

---

## 4. Client Flow Coverage (Critical Paths)

| Flow | Type | Steps |
|------|------|-------|
| Chat send → stream response | E2E/Manual | 1. Open app 2. Type message 3. Send 4. Verify stream |
| Plan task | E2E/Manual | 1. Type intent 2. Plan task 3. Verify plan card 4. Copy plan |
| Agent mode | E2E/Manual | 1. Enable agent 2. Send "search my context for X" 3. Verify tool result in reply |
| Create recipe | E2E/Manual | 1. Recipes panel 2. Add recipe 3. Add steps 4. Save |
| Schedule recipe | E2E/Manual | 1. Recipe 2. Schedule 3. Set cron 4. Verify in list |
| Workspace switch | E2E/Manual | 1. Auth 2. Create workspace 3. Switch 4. Verify context scope |
| Knowledge index | E2E/Manual | 1. Add context 2. Index 3. Search |
| Settings → API key | E2E/Manual | 1. Enter key 2. Reload 3. Send chat 4. Verify auth |

---

## 5. Data & Edge Cases

| Scenario | Expected |
|----------|----------|
| Empty messages array | 400 INVALID_BODY |
| Invalid workspace (special chars) | Sanitized to default |
| Missing title in context POST | 400 INVALID_INPUT |
| Missing name in recipe POST | 400 INVALID_INPUT |
| Unknown context/recipe/conversation id | 404 NOT_FOUND |
| Duplicate id in sync | Merge/upsert, no duplicate |
| Very long text (knowledge) | 413 DOC_TOO_LARGE |
| Malformed JSON in task plan | 400 PARSE_ERROR |
| Invalid cron expression | 400 or validation error |
| Empty tools in agent | Server injects default tools |

---

## 6. Environment Variants

| Config | Auth | API Key | Tokens | Tests |
|--------|------|---------|--------|-------|
| **No auth** | — | — | — | Anonymous user, no 401 on workspaces |
| **API_KEY only** | — | Set | — | 401 on chat without key |
| **USER_API_KEYS** | Set | — | — | 401 on workspaces without key |
| **Both** | Set | Set | — | Both required |
| **No GITHUB_TOKEN** | — | — | — | 503 on /api/github/* |
| **No VERCEL_TOKEN** | — | — | — | 503 on /api/vercel/* |
| **CRON_SECRET** | — | — | — | 401 on /api/cron without secret |
| **ALLOW_RECIPE_STEP_EXECUTION=0** | — | — | — | 503 on execute-step |
| **ENABLE_SCHEDULED_RECIPES=1** | — | — | — | Scheduler starts |

---

## 7. Regression Checklist (Manual)

Before release, verify:

- [ ] Chat streams correctly with Ollama
- [ ] Chat streams correctly with OpenAI (if deployed)
- [ ] Task planning returns valid plans
- [ ] Integrations panel shows correct status
- [ ] Knowledge search returns results
- [ ] Context/recipes persist across reload
- [ ] Workspace switcher works when auth configured
- [ ] Agent mode tools run (search_context, etc.)
- [ ] Execute step respects allowExecution toggle
- [ ] Schedules list shows scheduled recipes
- [ ] Cron endpoint runs when called with secret
- [ ] PWA installable, offline assets cached
- [ ] No console errors on load

---

## 8. Test Priorities

### P0 (Critical – must pass before merge)
- Chat proxy auth (API_KEY)
- Task plan validation
- Storage CRUD (context, recipes, conversations)
- Workspaces + userAuth when configured
- Health, config, integrations status
- Schedules CRUD
- Execute-step gating (503, 403)

### P1 (High – should pass)
- Knowledge index/search/list
- Usage summary
- Monitoring/status report
- Automations validate
- Plugins actions
- Cron endpoint
- Templates structure

### P2 (Nice to have)
- Vision describe (requires OpenAI key)
- Documents extract (PDF)
- Full agent loop (mock)
- GitHub/Vercel proxy success paths (mock)

---

## 9. Running Tests

```bash
# All tests
npm test

# Single file
node --test tests/server.test.js

# With reporter
node --test tests/**/*.test.js --test-reporter=spec
```

## 10. Coverage Summary

Current coverage focuses on:
- **Server**: Config, health, auth, integrations, task planning, plugins
- **Storage**: Unit tests for sanitizeWorkspace, listWorkspaces, mergeItems (via integration)
- **Auth**: isAuthConfigured, resolveUserId, userAuth behavior
- **Scheduler**: runDueJobs, runRecipeNow (mocked)
- **Templates**: Schema validation

E2E and full browser flows are documented as manual steps. Consider Playwright for future automation.
