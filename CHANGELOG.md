# Changelog

## [1.0.0] - 2026-04-07

### Architecture
- Refactored server.js from 3,954 to 1,142 lines (71% reduction)
- 37 route modules (including API v2)
- 145 lib modules organized by category
- 143 test files with 1,610+ tests

### Features
- Multi-backend LLM proxy (Ollama, vLLM, OpenAI)
- Agent system with 20+ tools, tool chaining, and long-term memory
- Multi-agent swarm orchestration with specialists
- Knowledge graph with entity extraction and relationship mapping
- Inverted search index with TF-IDF ranking
- Workflow engine with triggers, conditions, and variable interpolation
- Real-time collaborative workspaces (cursors, typing, document locking)
- Model quality routing with automatic promotion scoring

### Integrations
- MCP server and client for tool interop
- Slack bot with signature verification
- Discord bot with slash commands
- Email notifications with SMTP and digest
- Jira and Linear issue tracking
- GitHub and Vercel monitoring

### Infrastructure
- PostgreSQL migrations framework (6 schema migrations)
- Grafana dashboard template (15 panels)
- Webhook retry with dead-letter queue
- LRU caching with TTL and middleware
- Request timeout middleware
- Input validation on all critical routes
- RBAC with custom roles and permission inheritance
- Secret rotation (API keys, session secrets, admin keys)

### Developer Experience
- VS Code extension (chat, knowledge tree, recipes)
- Typed JavaScript SDK with TypeScript declarations
- CLI with 18 commands (init, chat, search, export, migrate, etc.)
- Client bundling with esbuild
- OpenAPI spec auto-generation

### Observability
- OpenTelemetry with child spans for agent tools and LLM calls
- Prometheus metrics with Grafana dashboard
- Structured audit logging with S3 archival
- Startup integration health checks
- Analytics dashboard with SVG charts

### Security
- API key enforcement in production
- Admin IP allowlist
- CSP headers (configurable)
- Rate limiting on all endpoints
- Log sanitization
- CORS configuration

### Client
- 16 JavaScript modules
- Dark/light theme toggle
- Keyboard shortcuts
- Onboarding wizard
- Offline queue with auto-replay
- WebSocket reconnection with backoff
- Agent trace visualization
- Streaming metrics (tokens/sec)
- PWA with service worker
