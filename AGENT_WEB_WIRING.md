# Agent Web wiring instructions

## Empty states

`client/src/views/empty-states.js` exports a single function:

```js
import { renderEmptyState } from "./empty-states.js";
```

`renderEmptyState(type)` returns an HTML string containing a centered card
with an SVG icon, title, description, and a CTA button (class `.es-cta`).
Supported types: `"chat"`, `"runs"`, `"knowledge"`, `"recipes"`, `"default"`.

### Integration points per view

Each view should import `renderEmptyState` and inject its output into the
DOM when the data list is empty. The `.es-empty` CSS rules are already
included in each view's stylesheet.

| View | File | Where to inject | Type |
|------|------|-----------------|------|
| Chat | `client/src/views/chat.js` | Inside `renderMessages()` when `state.messages.length === 0` — replace the `.sb-chat-placeholder` div's content with `renderEmptyState("chat")`. Wire the `.es-cta` button's click to `onNew()`. | `"chat"` |
| Runs | `client/src/views/runs.js` | Inside `renderTable()` when `state.rows.length === 0 && !state.error && !state.loading` — set `empty.innerHTML = renderEmptyState("runs")`. Wire `.es-cta` click to `startNewSession()`. | `"runs"` |
| Knowledge | `client/src/views/knowledge.js` | Inside `renderDocsTab()` after `reload()` when `docs.length === 0` — replace the `.kb-empty` div content with `renderEmptyState("knowledge")`. Wire `.es-cta` click to `showAddForm()`. | `"knowledge"` |
| Recipes | `client/src/views/recipes.js` | Inside `renderList()` when `state.recipes.length === 0` — set the `.rcp-empty` list item content to `renderEmptyState("recipes")`. Wire `.es-cta` click to `openDraft(null)`. | `"recipes"` |

### CSS

The `.es-empty` block styles are duplicated into each view's CSS file so
they render correctly regardless of which view is loaded:

- `client/src/views/chat.css`
- `client/src/views/runs.css`
- `client/src/views/knowledge.css`
- `client/src/views/recipes.css`

### Tests

- `tests/client-views-empty-states.test.js` — 13 unit tests covering all
  five types, CTA presence, structural classes, SVG icons, and unknown-type
  fallback. No JSDOM required.
