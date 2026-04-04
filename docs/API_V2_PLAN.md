# API v2 Plan

## Overview

API v2 introduces breaking changes to improve consistency, standards compliance, and developer experience. v1 remains supported during the migration period.

## Breaking Changes

### 1. Remove legacy `/api/` prefix

v2 routes are registered only at `/api/v2/`. The legacy `/api/` prefix (no version) is not supported for v2.

### 2. Consistent resource naming

All resource names use plurals. The `context` resource is renamed to `documents`.

| v1 | v2 |
|----|-----|
| `/api/v1/context` | `/api/v2/documents` |
| `/api/v1/conversations` | `/api/v2/conversations` |
| `/api/v1/webhooks` | `/api/v2/webhooks` |
| `/api/v1/workspaces` | `/api/v2/workspaces` |
| `/api/v1/plugins` | `/api/v2/plugins` |
| `/api/v1/marketplace` | `/api/v2/marketplace` |
| `/api/v1/execute-step` | `/api/v2/steps/execute` |
| `/api/v1/automations/validate` | `/api/v2/automations/validate` |
| `/api/v1/traces` | `/api/v2/traces` |
| `/api/v1/notifications` | `/api/v2/notifications` |
| `/api/v1/backup` | `/api/v2/backups` |
| `/api/v1/eval/sets` | `/api/v2/evaluations/sets` |
| `/api/v1/eval/run` | `/api/v2/evaluations/run` |
| `/api/v1/ocr` | `/api/v2/ocr` |
| `/api/v1/vision/describe` | `/api/v2/vision/describe` |
| `/api/v1/documents/extract` | `/api/v2/documents/extract` |
| `/api/v1/schedules` | `/api/v2/schedules` |

### 3. Consistent error format

All errors return a nested error object with a request ID:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Conversation not found",
    "details": null,
    "requestId": "req_abc123"
  }
}
```

v1 errors remain unchanged for backward compatibility.

### 4. Cursor-based pagination

All list endpoints use cursor-based pagination:

```json
{
  "items": [],
  "cursor": "eyJpZCI6MTAwfQ",
  "hasMore": true
}
```

Query parameters: `?cursor=...&limit=50` (default limit 50, max 100).

### 5. Auth: Authorization Bearer only

v2 endpoints accept only `Authorization: Bearer <token>`. The `x-api-key` header is not supported on v2 routes.

### 6. Streaming: typed SSE events

Streaming responses use standard SSE format with typed events:

```
event: message
data: {"content": "Hello"}

event: done
data: {}

event: error
data: {"code": "STREAM_ERROR", "message": "..."}
```

### 7. Rate limiting headers

All v2 responses include standard rate limit headers:

```
RateLimit-Limit: 100
RateLimit-Remaining: 97
RateLimit-Reset: 1672531200
```

## Endpoint Mapping (v1 to v2)

| Method | v1 Path | v2 Path |
|--------|---------|---------|
| GET | `/api/v1/conversations` | `/api/v2/conversations` |
| POST | `/api/v1/conversations` | `/api/v2/conversations` |
| GET | `/api/v1/conversations/:id` | `/api/v2/conversations/:id` |
| PUT | `/api/v1/conversations/:id` | `/api/v2/conversations/:id` |
| DELETE | `/api/v1/conversations/:id` | `/api/v2/conversations/:id` |
| POST | `/api/v1/conversations/:id/branch` | `/api/v2/conversations/:id/branches` |
| GET | `/api/v1/conversations/:id/tree` | `/api/v2/conversations/:id/tree` |
| GET | `/api/v1/conversations/:id/branches` | `/api/v2/conversations/:id/branches` |
| GET | `/api/v1/conversations/branches/:branchId` | `/api/v2/conversations/branches/:branchId` |
| DELETE | `/api/v1/conversations/branches/:branchId` | `/api/v2/conversations/branches/:branchId` |
| POST | `/api/v1/backup` | `/api/v2/backups` |
| GET | `/api/v1/backup` | `/api/v2/backups` |
| POST | `/api/v1/backup/restore/:id` | `/api/v2/backups/:id/restore` |
| POST | `/api/v1/automations/validate` | `/api/v2/automations/validate` |
| GET | `/api/v1/plugins/actions` | `/api/v2/plugins/actions` |
| GET | `/api/v1/plugins` | `/api/v2/plugins` |
| POST | `/api/v1/plugins/execute` | `/api/v2/plugins/execute` |
| GET | `/api/v1/marketplace` | `/api/v2/marketplace` |
| GET | `/api/v1/marketplace/:packId` | `/api/v2/marketplace/:packId` |
| POST | `/api/v1/marketplace/:packId/install` | `/api/v2/marketplace/:packId/install` |
| DELETE | `/api/v1/marketplace/:packId/install` | `/api/v2/marketplace/:packId/install` |
| GET | `/api/v1/workspaces/:id/plugins` | `/api/v2/workspaces/:id/plugins` |
| GET | `/api/v1/workspaces/:id/presence` | `/api/v2/workspaces/:id/presence` |
| GET | `/api/v1/webhooks` | `/api/v2/webhooks` |
| POST | `/api/v1/webhooks` | `/api/v2/webhooks` |
| DELETE | `/api/v1/webhooks/:id` | `/api/v2/webhooks/:id` |
| GET | `/api/v1/notifications` | `/api/v2/notifications` |
| PATCH | `/api/v1/notifications/:id` | `/api/v2/notifications/:id` |
| PATCH | `/api/v1/notifications/mark-all-read` | `/api/v2/notifications/mark-all-read` |
| POST | `/api/v1/execute-step` | `/api/v2/steps/execute` |
| GET | `/api/v1/traces` | `/api/v2/traces` |
| GET | `/api/v1/traces/:id` | `/api/v2/traces/:id` |
| DELETE | `/api/v1/traces/:id` | `/api/v2/traces/:id` |
| POST | `/api/v1/traces/record` | `/api/v2/traces/record` |
| POST | `/api/v1/traces/:id/replay` | `/api/v2/traces/:id/replay` |
| GET | `/api/v1/agent/trajectories` | `/api/v2/agent/trajectories` |
| GET | `/api/v1/agent/trajectory/:runId` | `/api/v2/agent/trajectories/:runId` |
| POST | `/api/v1/ocr` | `/api/v2/ocr` |
| POST | `/api/v1/vision/describe` | `/api/v2/vision/describe` |
| POST | `/api/v1/documents/extract` | `/api/v2/documents/extract` |
| GET | `/api/v1/eval/sets` | `/api/v2/evaluations/sets` |
| POST | `/api/v1/eval/run` | `/api/v2/evaluations/run` |
| GET | `/api/v1/ws-token` | `/api/v2/ws-token` |

## Migration Timeline

### Phase 1: Parallel Support (Current)

- v2 routes added alongside v1
- Both v1 and v2 routes work simultaneously
- v2 uses new error format, pagination, and auth patterns
- v1 behavior unchanged

### Phase 2: v1 Sunset Notice

- v1 routes return `Sunset: 2027-01-01T00:00:00Z` header
- v1 routes return `Deprecation: true` header
- Documentation updated to recommend v2
- Migration guide published

### Phase 3: v1 Removal

- v1 routes return `410 Gone` with migration instructions
- Only v2 routes serve traffic
- Legacy `/api/` prefix routes also return 410
