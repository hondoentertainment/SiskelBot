# Phases 24–28: Implementation Plan

## Phase 24: Backup & Restore

**Goal:** Automated and manual backup/restore of workspace data.

### Scope
- **Backup:** ZIP archive of `data/` (or per-workspace subset) to `backups/` with timestamp
- **Restore:** Replace `data/` from selected backup archive
- **Export workspace:** Export single workspace as JSON/ZIP (context, recipes, conversations)
- **Import workspace:** Import from export file
- **API:** `GET /api/backups`, `POST /api/backups` (create), `POST /api/backups/restore/:id`
- **Client:** Backup/Restore in Settings or dedicated Admin panel
- **Cron:** Optional `BACKUP_CRON=0 2 * * *` (daily 2am) when scheduler enabled

### Constraints
- Admin or API_KEY required for backup/restore
- Max backups retained (e.g. 7)

---

## Phase 25: Admin Dashboard

**Goal:** Server-side admin UI for users, workspaces, quotas, and system health.

### Scope
- **Route:** `GET /admin` – protected by `ADMIN_API_KEY` or admin role
- **UI:** Simple dashboard with tabs/sections:
  - Users (list, quota override)
  - Workspaces (usage, quota)
  - System health (backend, storage, recent errors)
  - Audit log (recent executions, webhooks, auth)
  - Schedules (list, enable/disable)
- **API:** `GET /api/admin/*` – users, workspaces, audit, health (admin-only)
- **Client:** Standalone admin HTML or section in main app when admin

### Constraints
- Admin routes require `ADMIN_API_KEY` or `req.session?.isAdmin`

---

## Phase 26: Accessibility (a11y) Audit & Fixes

**Goal:** WCAG 2.1 AA compliance and keyboard/screen-reader usability.

### Scope
- **Keyboard nav:** All interactive elements focusable; logical tab order; modals trap focus
- **ARIA:** Labels, roles, live regions for dynamic content
- **Focus:** Visible focus ring; skip-link to main content
- **Modals:** Escape to close; focus restore on close
- **Reduced motion:** Respect `prefers-reduced-motion`
- **Document:** `docs/ACCESSIBILITY.md` with audit findings and checklist

### Constraints
- No breaking changes to existing flows
- Use existing sr-only, aria-* where present

---

## Phase 27: In-App Notification Center

**Goal:** Central place for system and event notifications.

### Scope
- **Storage:** `data/notifications.json` or per-user `data/users/{id}/notifications.json`
- **Events:** `recipe_executed`, `schedule_completed`, `quota_warning`, `webhook_failed`
- **API:** `GET /api/notifications`, `PATCH /api/notifications/:id` (mark read)
- **Client:** Bell icon in header; dropdown with list; unread count badge
- **Real-time:** Polling every 30s or on focus

### Constraints
- Notifications scoped by user when auth on

---

## Phase 28: Embeddings API & Semantic Search

**Goal:** Expose embeddings for custom RAG and semantic search over context.

### Scope
- **API:** `POST /api/embeddings` – `{ text }` → `{ embedding: number[] }`
- **Backend:** OpenAI `text-embedding-3-small` when `OPENAI_API_KEY`; optional fallback
- **Knowledge store:** Add embedding-based search alongside existing keyword search
- **RAG:** Option to use semantic search (embed query, nearest-neighbor) for context retrieval
- **Rate limit:** Same or stricter than chat

### Constraints
- Requires OpenAI for embeddings unless local embedder added later
- Optional feature; no breaking changes to existing RAG

---

## Implementation Order

| Phase | Agent | Dependencies |
|-------|-------|--------------|
| 24 | Backup & Restore | Phase 10 (storage) |
| 25 | Admin Dashboard | Phase 14 (auth) |
| 26 | Accessibility | None |
| 27 | Notification Center | Phase 14, 22 |
| 28 | Embeddings API | None |

**Parallel batch 1:** 24, 25, 26, 27 (4 agents)
**Parallel batch 2:** 28 (1 agent)
