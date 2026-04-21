# Repo-level RAG (Phase 63.1)

`lib/repo-rag.js` indexes repository source files into a per-workspace
inverted token index so agents can search code by keyword and resolve to
specific file/line positions.

## API surface

| Export | Purpose |
|--------|---------|
| `indexRepository({ workspaceId, repoId, files })` | Index a repo. `files` is `[{ path, content }]` |
| `searchRepo({ workspaceId, query, limit })` | Token-overlap search across all indexed repos in the workspace |
| `getRepoStats(workspaceId)` | Per-repo file count, language breakdown, token totals |
| `listRepos(workspaceId)` | Repo IDs and metadata |
| `removeRepo({ workspaceId, repoId })` | Drop a repo and its index entries |

## Storage

`data/repo-rag/{workspaceId}.json`. Single JSON file per workspace —
acceptable for repos up to roughly 50K files; beyond that, switch to
SQLite/Postgres backend.

## Inputs and limits

- Each `files[i].content` is read in full into memory. Large monorepos can
  push the heap — chunk uploads at the caller.
- Language detection is extension-based via `EXT_TO_LANG`. Unknown
  extensions default to `text`. Tree-sitter AST chunking is **not**
  implemented yet (planned, not in current build).
- Tokenisation is lowercase ASCII word splitting. Identifiers in non-Latin
  scripts will not index well.
- The token index does not store full content — `searchRepo` returns
  positions; the caller fetches surrounding source.

## Failure modes

| Symptom | Cause | Mitigation |
|--------|------|-----------|
| `searchRepo` returns nothing for a known symbol | Symbol uses non-ASCII or punctuation tokenizer drops | Fall back to `lib/search-index.js` substring search |
| Index file grows unbounded | `removeRepo` not called before re-indexing | Always `removeRepo` then `indexRepository` for refresh |
| Cross-repo search returns the wrong repo | All workspace repos share the same flat index | Filter by `repoId` in the result list (caller responsibility) |
| Stats slow on large indexes | Stats walk the full token map | Cache stats out-of-band or paginate |
| Concurrent indexing corrupts the file | `withPathLock` is per-file; cross-process locks rely on lockfile semantics | Funnel indexing through a single worker, or move to SQLite backend |

## HITL guarantees

`searchRepo` is read-only. `indexRepository` and `removeRepo` mutate
storage but never touch the network. No HITL gating required for this
module on its own; gate the **upstream** ingestion path (which decides
which files to feed it) instead.

## Disabling

Set `WORKSPACE_FILE_TOOLS=0` (the default) to keep the `search_repo`
agent tool unregistered. The module continues to function for direct
HTTP callers; remove the route from `routes/index.js` to remove the
HTTP surface entirely.

## Related

- `lib/search-index.js` for general-purpose substring search
- `lib/knowledge-graph.js` for entity-level cross-document linking
- `lib/workspace-fs-tools.js` for file reads gated by `WORKSPACE_ROOT`
