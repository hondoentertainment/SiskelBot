# SiskelBot Accessibility (a11y) Audit & Fixes

**Phase 26** – WCAG 2.1 AA alignment for the single-page chat app in `client/index.html`.

## Audit Checklist

### Keyboard navigation ✓
- [x] All interactive elements reachable via Tab (buttons, inputs, links, selects, details/summary)
- [x] Logical tab order matches visual layout
- [x] Modals trap focus (Tab cycles within modal)
- [x] Escape closes modals (continue, approval, status report, context add, recipe create, recipe schedule)
- [x] Focus returns to triggering element when modal closes

### Focus visible ✓
- [x] Clear focus ring (2px solid #60a5fa, 2px offset) on all focusable elements
- [x] Uses `:focus-visible` so focus ring appears only for keyboard users (not mouse clicks)
- [x] Applied to: `a`, `button`, `input`, `textarea`, `select`, `summary`, `[tabindex]:not([tabindex="-1"])`

### Skip link ✓
- [x] "Skip to main content" link at top of page
- [x] Visually hidden off-screen until focused
- [x] Targets `#main-content` (main landmark)
- [x] Visible on focus via `top: 1rem`

### ARIA attributes ✓
- [x] Modals use `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to title
- [x] `aria-label` on icon-only buttons (e.g. Attach image, Voice input, Dismiss)
- [x] `aria-live="polite"` for dynamic content (chat log, notice banner, live region, search counts)
- [x] `role="log"` on chat container with `aria-live="polite"` and `aria-relevant="additions text"`
- [x] `aria-label` on selects without visible labels (profile, workspace, schedule preset, add step)
- [x] `aria-describedby` for checkbox hints (allow-recipe-execution-hint, agent-mode-hint)
- [x] Native `<details>`/`<summary>` provide `aria-expanded` automatically

### Color contrast ✓
- [x] Primary text `#e2e8f0` on `#0f172a` (background): ~15:1
- [x] Secondary `#94a3b8` on `#1e293b`: ~8:1
- [x] Links `#60a5fa` on dark backgrounds: >4.5:1
- [x] Meets WCAG AA (4.5:1 normal, 3:1 large)

### Reduced motion ✓
- [x] `@media (prefers-reduced-motion: reduce)` disables animations and transitions
- [x] Typing indicator bounce animation minimized
- [x] `scrollIntoView` uses `behavior: 'auto'` when reduced-motion is preferred (instead of `'smooth'`)

### Structure ✓
- [x] Single `<h1>` per page ("Streaming Assistant")
- [x] Main content in `<main id="main-content" role="main">`
- [x] Header, nav-like panels, and main region landmarks
- [x] `.sr-only` for screen-reader-only labels (e.g. Profile, Model, Search messages)

## Fixes Applied

| Area | Fix |
|------|-----|
| Skip link | Changed from "Skip to message input" → "Skip to main content", `href="#main-content"` |
| Main landmark | Added `id="main-content"` and `role="main"` to `<main>` |
| Focus ring | Extended `:focus-visible` to `a`, `[tabindex]` for completeness |
| Modals | Focus trap (Tab cycles within modal), Escape to close, return focus on close |
| Modal open | Save `document.activeElement` before showing; focus first focusable when modal opens |
| Approval/status | MutationObserver watches `.visible` class; on add, saves focus and focuses first focusable |
| Context/recipe/schedule | Set `_a11yReturnFocus` at open; schedule modal focuses first focusable on display |
| Reduced motion | `prefers-reduced-motion` media query; `scrollIntoView` respects preference |
| ARIA | `aria-label` on schedule preset select; existing attributes retained |

## Testing

### Keyboard-only navigation
1. Tab through the page: skip link → header (model, profile, buttons) → main content → input area
2. Open a modal (e.g. Conversations, Status, Add context): Tab should cycle within modal
3. Press Escape: modal should close and focus return to opener
4. Open details (e.g. Settings): Tab should reach controls inside

### Screen reader
- NVDA/JAWS: Landmarks, headings, and live regions should be announced
- Chat messages and notices should be announced via `aria-live`

### Reduced motion
- Enable "Reduce motion" in OS (Windows: Settings → Accessibility → Visual effects; macOS: System Preferences → Accessibility → Display)
- Reload app: typing indicator should not animate, scrolls should be instant

## Modals Reference

| Modal | ID | Focus trap | Escape | Return focus |
|-------|-----|------------|--------|--------------|
| Continue previous chat | `continue-modal` | ✓ (custom) | ✓ | ✓ |
| Approval | `approval-modal` | ✓ | ✓ | ✓ |
| Status report | `status-report-modal` | ✓ | ✓ | ✓ |
| Add context | `context-add-modal` | ✓ | ✓ | ✓ |
| New recipe | `recipe-create-modal` | ✓ | ✓ | ✓ |
| Schedule recipe | `recipe-schedule-modal` | ✓ | ✓ | ✓ |

## Related

- [PHASES_24-28_PLAN.md](./PHASES_24-28_PLAN.md) – Phase 26 scope
- [AGENT_MODE.md](./AGENT_MODE.md) – Agent-mode features
