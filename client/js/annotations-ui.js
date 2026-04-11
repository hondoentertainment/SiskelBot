/**
 * Phase 41.4: Collaborative annotations UI.
 *
 * Renders inline comment indicators on messages, expandable threads with
 * replies, emoji reaction pickers, and a popover for creating new annotations
 * over selected text ranges.
 *
 * Usage:
 *   import { createAnnotationRenderer } from "./annotations-ui.js";
 *   const renderer = createAnnotationRenderer(document.body);
 *   renderer.attachToMessage(messageEl, "msg-123");
 *
 * The renderer talks to the server via the /api/v1/annotations endpoints and
 * subscribes to the existing wsManager (when supplied) to receive realtime
 * updates from other users.
 */

const REACTION_EMOJIS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83C\uDF89", "\uD83D\uDE2E", "\uD83D\uDC40"];

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "style" && typeof v === "object") {
        Object.assign(node.style, v);
      } else if (k === "className") {
        node.className = v;
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  if (children != null) {
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    } else if (typeof children === "string") {
      node.textContent = children;
    } else {
      node.appendChild(children);
    }
  }
  return node;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.error || j.message || detail; } catch (_) {}
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Create an annotation renderer bound to a container element.
 * @param {HTMLElement} container - root element for floating popovers/threads
 * @param {{ workspaceId?: string, currentUserId?: string, wsManager?: { subscribe?: Function } }} [opts]
 */
export function createAnnotationRenderer(container, opts = {}) {
  const workspaceId = opts.workspaceId || "default";
  const currentUserId = opts.currentUserId || "anonymous";
  const wsManager = opts.wsManager || null;

  /** @type {Map<string, { messageEl: HTMLElement, indicatorEl: HTMLElement, threadEl?: HTMLElement, annotations: Array }>} */
  const messageState = new Map();

  if (wsManager && typeof wsManager.subscribe === "function") {
    wsManager.subscribe((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "annotation_created") {
        handleRemoteCreate(msg.annotation);
      } else if (msg.type === "annotation_updated") {
        handleRemoteUpdate(msg.annotation);
      } else if (msg.type === "annotation_deleted") {
        handleRemoteDelete(msg.annotationId);
      } else if (msg.type === "annotation_reaction") {
        handleRemoteReaction(msg.annotationId, msg.reactions);
      }
    });
  }

  function handleRemoteCreate(ann) {
    if (!ann || ann.targetType !== "message") return;
    const state = messageState.get(ann.targetId);
    if (!state) return;
    state.annotations.push(ann);
    updateIndicator(state);
    if (state.threadEl) {
      renderThreadInto(state.threadEl, state.annotations);
    }
  }

  function handleRemoteUpdate(ann) {
    if (!ann) return;
    for (const state of messageState.values()) {
      const idx = state.annotations.findIndex((a) => a.id === ann.id);
      if (idx >= 0) {
        state.annotations[idx] = ann;
        if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
        updateIndicator(state);
        return;
      }
    }
  }

  function handleRemoteDelete(annotationId) {
    for (const state of messageState.values()) {
      const idx = state.annotations.findIndex((a) => a.id === annotationId);
      if (idx >= 0) {
        state.annotations.splice(idx, 1);
        if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
        updateIndicator(state);
        return;
      }
    }
  }

  function handleRemoteReaction(annotationId, reactions) {
    for (const state of messageState.values()) {
      const ann = state.annotations.find((a) => a.id === annotationId);
      if (ann) {
        ann.reactions = reactions || {};
        if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
        return;
      }
    }
  }

  function updateIndicator(state) {
    const visible = state.annotations.filter((a) => !a.parentId && !a.resolved);
    const count = visible.length;
    state.indicatorEl.textContent = count > 0 ? `\uD83D\uDCAC ${count}` : "\uD83D\uDCAC";
    state.indicatorEl.style.display = count > 0 ? "inline-block" : "none";
  }

  async function loadAnnotations(messageId) {
    const url = `/api/v1/annotations?target=message:${encodeURIComponent(messageId)}&workspace=${encodeURIComponent(workspaceId)}&includeReplies=1`;
    const data = await fetchJson(url);
    return Array.isArray(data?.items) ? data.items : [];
  }

  async function postAnnotation(payload) {
    return fetchJson("/api/v1/annotations", {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, ...payload }),
    });
  }

  async function postReply(parentId, text) {
    return fetchJson(`/api/v1/annotations/${encodeURIComponent(parentId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, text }),
    });
  }

  async function postReaction(annotationId, emoji) {
    return fetchJson(`/api/v1/annotations/${encodeURIComponent(annotationId)}/react`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, emoji }),
    });
  }

  async function postResolve(annotationId, resolved) {
    const path = resolved ? "resolve" : "unresolve";
    return fetchJson(`/api/v1/annotations/${encodeURIComponent(annotationId)}/${path}`, {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId }),
    });
  }

  async function deleteAnn(annotationId) {
    return fetchJson(`/api/v1/annotations/${encodeURIComponent(annotationId)}?workspace=${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    });
  }

  function renderThreadInto(threadEl, annotations) {
    threadEl.innerHTML = "";
    const roots = annotations.filter((a) => !a.parentId);
    const repliesByParent = new Map();
    for (const a of annotations) {
      if (a.parentId) {
        if (!repliesByParent.has(a.parentId)) repliesByParent.set(a.parentId, []);
        repliesByParent.get(a.parentId).push(a);
      }
    }

    for (const root of roots) {
      threadEl.appendChild(renderAnnotationCard(root, repliesByParent.get(root.id) || []));
    }

    if (roots.length === 0) {
      threadEl.appendChild(el("div", { className: "annotation-empty" }, "No comments yet."));
    }
  }

  function renderAnnotationCard(annotation, replies) {
    const card = el("div", { className: "annotation-card", "data-id": annotation.id });

    const header = el("div", { className: "annotation-header" }, [
      el("span", { className: "annotation-author" }, annotation.userId),
      el("span", { className: "annotation-time" }, new Date(annotation.createdAt).toLocaleString()),
      annotation.resolved ? el("span", { className: "annotation-resolved-tag" }, "resolved") : null,
    ]);
    card.appendChild(header);

    const body = el("div", { className: "annotation-body" }, annotation.text);
    card.appendChild(body);

    // Reactions row
    const reactionsRow = el("div", { className: "annotation-reactions" });
    const reactions = annotation.reactions || {};
    for (const [emoji, users] of Object.entries(reactions)) {
      const userList = Array.isArray(users) ? users : [];
      const chip = el("button", {
        className: "annotation-reaction-chip" + (userList.includes(currentUserId) ? " mine" : ""),
        type: "button",
        onclick: async () => {
          try {
            const result = await postReaction(annotation.id, emoji);
            annotation.reactions = result.reactions || {};
            if (card.parentElement) renderThreadInto(card.parentElement, collectAll());
          } catch (_) {}
        },
      }, `${emoji} ${userList.length}`);
      reactionsRow.appendChild(chip);
    }
    const addReactionBtn = el("button", {
      className: "annotation-add-reaction",
      type: "button",
      onclick: (e) => {
        e.stopPropagation();
        addReactionPicker(card, annotation.id);
      },
    }, "+");
    reactionsRow.appendChild(addReactionBtn);
    card.appendChild(reactionsRow);

    // Action row
    const actions = el("div", { className: "annotation-actions" });
    const replyBtn = el("button", {
      className: "annotation-reply-btn",
      type: "button",
      onclick: () => showReplyForm(card, annotation.id),
    }, "Reply");
    actions.appendChild(replyBtn);

    const resolveBtn = el("button", {
      className: "annotation-resolve-btn",
      type: "button",
      onclick: async () => {
        try {
          await postResolve(annotation.id, !annotation.resolved);
          annotation.resolved = !annotation.resolved;
          if (card.parentElement) renderThreadInto(card.parentElement, collectAll());
        } catch (_) {}
      },
    }, annotation.resolved ? "Unresolve" : "Resolve");
    actions.appendChild(resolveBtn);

    if (annotation.userId === currentUserId) {
      const deleteBtn = el("button", {
        className: "annotation-delete-btn",
        type: "button",
        onclick: async () => {
          if (!confirm("Delete this annotation?")) return;
          try {
            await deleteAnn(annotation.id);
            for (const state of messageState.values()) {
              const idx = state.annotations.findIndex((a) => a.id === annotation.id);
              if (idx >= 0) {
                state.annotations.splice(idx, 1);
                if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
                updateIndicator(state);
              }
            }
          } catch (_) {}
        },
      }, "Delete");
      actions.appendChild(deleteBtn);
    }
    card.appendChild(actions);

    // Replies
    if (replies && replies.length > 0) {
      const repliesEl = el("div", { className: "annotation-replies" });
      for (const r of replies) {
        repliesEl.appendChild(renderAnnotationCard(r, []));
      }
      card.appendChild(repliesEl);
    }

    return card;
  }

  function collectAll() {
    const seen = new Set();
    const all = [];
    for (const state of messageState.values()) {
      for (const a of state.annotations) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          all.push(a);
        }
      }
    }
    return all;
  }

  function showReplyForm(card, parentId) {
    const existing = card.querySelector(".annotation-reply-form");
    if (existing) { existing.remove(); return; }
    const textarea = el("textarea", { className: "annotation-reply-input", rows: "2", placeholder: "Write a reply\u2026" });
    const submit = el("button", {
      type: "button",
      className: "annotation-reply-submit",
      onclick: async () => {
        const text = textarea.value.trim();
        if (!text) return;
        try {
          const result = await postReply(parentId, text);
          const ann = result?.annotation;
          if (ann) {
            for (const state of messageState.values()) {
              if (state.annotations.find((a) => a.id === parentId)) {
                state.annotations.push(ann);
                if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
                updateIndicator(state);
                break;
              }
            }
          }
          form.remove();
        } catch (_) {}
      },
    }, "Post");
    const form = el("div", { className: "annotation-reply-form" }, [textarea, submit]);
    card.appendChild(form);
    textarea.focus();
  }

  function addReactionPicker(annotationEl, annotationId) {
    const existing = annotationEl.querySelector(".annotation-reaction-picker");
    if (existing) { existing.remove(); return; }
    const picker = el("div", { className: "annotation-reaction-picker" });
    for (const emoji of REACTION_EMOJIS) {
      picker.appendChild(el("button", {
        type: "button",
        className: "annotation-reaction-pick",
        onclick: async () => {
          try {
            const result = await postReaction(annotationId, emoji);
            for (const state of messageState.values()) {
              const ann = state.annotations.find((a) => a.id === annotationId);
              if (ann) {
                ann.reactions = result.reactions || {};
                if (state.threadEl) renderThreadInto(state.threadEl, state.annotations);
                break;
              }
            }
            picker.remove();
          } catch (_) {}
        },
      }, emoji));
    }
    annotationEl.appendChild(picker);
  }

  function attachToMessage(messageEl, messageId) {
    if (!messageEl || !messageId) return;
    if (messageState.has(messageId)) return;

    const indicator = el("button", {
      className: "annotation-indicator",
      type: "button",
      title: "Comments",
      style: { display: "none" },
    }, "\uD83D\uDCAC");

    const threadHost = el("div", { className: "annotation-thread", style: { display: "none" } });

    const state = {
      messageEl,
      indicatorEl: indicator,
      threadEl: threadHost,
      annotations: [],
    };
    messageState.set(messageId, state);

    indicator.addEventListener("click", async () => {
      const isHidden = threadHost.style.display === "none";
      if (isHidden) {
        try {
          state.annotations = await loadAnnotations(messageId);
        } catch (_) { state.annotations = []; }
        renderThreadInto(threadHost, state.annotations);
        appendNewAnnotationForm(threadHost, messageId);
        threadHost.style.display = "block";
      } else {
        threadHost.style.display = "none";
      }
    });

    messageEl.appendChild(indicator);
    messageEl.appendChild(threadHost);

    // Async load to populate the unread count badge
    loadAnnotations(messageId).then((items) => {
      state.annotations = items;
      updateIndicator(state);
    }).catch(() => {});
  }

  function appendNewAnnotationForm(threadEl, messageId) {
    if (threadEl.querySelector(".annotation-new-form")) return;
    const textarea = el("textarea", { className: "annotation-new-input", rows: "2", placeholder: "Add a comment\u2026" });
    const submit = el("button", {
      type: "button",
      className: "annotation-new-submit",
      onclick: async () => {
        const text = textarea.value.trim();
        if (!text) return;
        try {
          const result = await postAnnotation({ targetType: "message", targetId: messageId, text });
          const ann = result?.annotation;
          if (ann) {
            const state = messageState.get(messageId);
            if (state) {
              state.annotations.push(ann);
              renderThreadInto(threadEl, state.annotations);
              appendNewAnnotationForm(threadEl, messageId);
              updateIndicator(state);
            }
          }
          textarea.value = "";
        } catch (_) {}
      },
    }, "Comment");
    threadEl.appendChild(el("div", { className: "annotation-new-form" }, [textarea, submit]));
  }

  function showAnnotationPopover(x, y, anchor) {
    const existing = container.querySelector(".annotation-popover");
    if (existing) existing.remove();
    const textarea = el("textarea", { className: "annotation-popover-input", rows: "3", placeholder: "Add a comment\u2026" });
    const popover = el("div", {
      className: "annotation-popover",
      style: { position: "absolute", left: `${x}px`, top: `${y}px`, zIndex: "9999" },
    }, [
      textarea,
      el("button", {
        type: "button",
        className: "annotation-popover-submit",
        onclick: async () => {
          const text = textarea.value.trim();
          if (!text || !anchor || !anchor.targetType || !anchor.targetId) {
            popover.remove();
            return;
          }
          try {
            await postAnnotation({
              targetType: anchor.targetType,
              targetId: anchor.targetId,
              text,
              anchor: anchor.range,
            });
          } catch (_) {}
          popover.remove();
        },
      }, "Comment"),
      el("button", {
        type: "button",
        className: "annotation-popover-cancel",
        onclick: () => popover.remove(),
      }, "Cancel"),
    ]);
    container.appendChild(popover);
    textarea.focus();
    return popover;
  }

  function highlightTextRange(element, range) {
    if (!element || !range || range.start == null || range.end == null) return;
    try {
      const text = element.textContent || "";
      if (range.start < 0 || range.end > text.length || range.start >= range.end) return;
      const before = text.slice(0, range.start);
      const middle = text.slice(range.start, range.end);
      const after = text.slice(range.end);
      element.innerHTML = "";
      element.appendChild(document.createTextNode(before));
      element.appendChild(el("span", { className: "annotation-highlight" }, middle));
      element.appendChild(document.createTextNode(after));
    } catch (_) {}
  }

  function renderThread(annotations) {
    const host = el("div", { className: "annotation-thread-static" });
    renderThreadInto(host, annotations || []);
    return host;
  }

  function destroy() {
    messageState.clear();
    const existing = container.querySelector(".annotation-popover");
    if (existing) existing.remove();
  }

  return {
    attachToMessage,
    showAnnotationPopover,
    renderThread,
    highlightTextRange,
    addReactionPicker,
    destroy,
  };
}
