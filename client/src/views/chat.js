/**
 * Chat view for the SiskelBot SPA shell.
 *
 * default export: mount(el, ctx)
 * named exports:  parseSseLine, renderMarkdown, formatUsd
 *
 * The pure helpers are defined at the top so they can be imported and
 * unit-tested without JSDOM.
 */

import { renderChatSignals } from "./inspector-content.js";

const DEFAULT_API_BASE = "/api/v1";
const DEFAULT_WORKSPACE = "default";
const MODEL_OPTIONS = ["gpt-4o-mini", "gpt-4o", "llama3.1"];
const MODEL_STORAGE_KEY = "siskelbot:chat:model";
const CSS_HREF = new URL("./chat.css", import.meta.url).href;

function pushChatSignalsToInspector(signals) {
  try {
    const ins = globalThis.SiskelbotShell?.inspector;
    if (!ins) return;
    ins.setTitle?.("Last response");
    ins.setContent?.(renderChatSignals(signals));
  } catch { /* noop */ }
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ────────────────────────────────────────────────────────────────────

/**
 * Parse a single line from an SSE stream.
 * Accepts:
 *   - "data: {json}"     → { type: "data", data: <parsed> }
 *   - "data: [DONE]"     → { type: "done", data: null }
 *   - "event: foo"       → { type: "event", data: "foo" }
 *   - blank / comment    → null
 * Malformed JSON returns { type: "data", data: "<raw string>" } for graceful degradation,
 * but JSON parse errors never throw.
 */
export function parseSseLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) return null;
  if (trimmed.startsWith(":")) return null; // SSE comment
  const colon = trimmed.indexOf(":");
  if (colon === -1) return null;
  const field = trimmed.slice(0, colon).trim();
  let value = trimmed.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  if (field === "event") return { type: "event", data: value };
  if (field === "data") {
    if (value === "[DONE]") return { type: "done", data: null };
    try {
      return { type: "data", data: JSON.parse(value) };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Escape HTML entities in a string.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a URL for use in an href attribute. Rejects javascript: / data:.
 */
function safeHref(url) {
  const s = String(url || "").trim();
  if (/^\s*javascript:/i.test(s)) return "#";
  if (/^\s*data:/i.test(s)) return "#";
  if (/^\s*vbscript:/i.test(s)) return "#";
  return escapeHtml(s);
}

/**
 * Render a minimal, safe subset of Markdown to HTML.
 * All user text is HTML-escaped first. Supports fenced code,
 * inline code, bold, italic, links, headings (#/##/###) and bullet lists.
 */
export function renderMarkdown(text) {
  if (text == null) return "";
  const src = String(text);

  // 1. Extract fenced code blocks first so their contents are left alone.
  const fences = [];
  let work = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const idx = fences.length;
    const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    fences.push(`<pre><code${langClass}>${escapeHtml(body)}</code></pre>`);
    return `\u0000FENCE${idx}\u0000`;
  });

  // 2. Escape the remaining text.
  work = escapeHtml(work);

  // 3. Inline code (after escaping so backticks are preserved).
  work = work.replace(/`([^`\n]+)`/g, (_m, inner) => `<code>${inner}</code>`);

  // 4. Links [text](url) — escaped already, so we rebuild the href.
  work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
    `<a href="${safeHref(url)}" rel="noopener noreferrer" target="_blank">${label}</a>`,
  );

  // 5. Bold + italic.
  work = work.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // 6. Line-oriented transforms (headings, bullets).
  const lines = work.split("\n");
  const out = [];
  let inList = false;
  for (const ln of lines) {
    const h3 = ln.match(/^###\s+(.*)$/);
    const h2 = ln.match(/^##\s+(.*)$/);
    const h1 = ln.match(/^#\s+(.*)$/);
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (h3) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h3>${h3[1]}</h3>`); continue; }
    if (h2) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h2>${h2[1]}</h2>`); continue; }
    if (h1) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h1>${h1[1]}</h1>`); continue; }
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    out.push(ln);
  }
  if (inList) out.push("</ul>");
  work = out.join("\n");

  // 7. Paragraph-ish line breaks (preserve single newlines as <br>).
  work = work.replace(/\n{2,}/g, "</p><p>");
  work = `<p>${work}</p>`.replace(/<p>(\s*<(?:h1|h2|h3|ul|pre)[^>]*>)/g, "$1");

  // 8. Re-insert fenced code blocks.
  work = work.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] || "");

  return work;
}

/**
 * Format a USD number: $0.0042 / $1.23 / — for non-number.
 */
export function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const digits = abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

// ────────────────────────────────────────────────────────────────────
// DOM mount
// ────────────────────────────────────────────────────────────────────

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`link[data-view="chat"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-view", "chat");
  document.head.appendChild(link);
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "onclick" || k === "onkeydown" || k === "oninput" || k === "onchange" || k === "onscroll") {
        el.addEventListener(k.slice(2), v);
      } else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, { credentials: "same-origin", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function mount(el, ctx = {}) {
  ensureStylesheet();
  const apiBase = ctx.apiBase || DEFAULT_API_BASE;
  const workspace = ctx.workspace || DEFAULT_WORKSPACE;

  // State
  const state = {
    conversations: [],
    currentId: null,
    messages: [],
    streaming: false,
    autoScroll: true,
    model: readModel(),
    requestId: null,
  };
  let rtUnsub = null;

  el.innerHTML = "";
  const root = h("div", { class: "sb-chat" });
  el.appendChild(root);

  // Layout
  const sidebar = h("aside", { class: "sb-chat-side" });
  const sideHeader = h("div", { class: "sb-chat-side-header" },
    h("span", { class: "sb-chat-title" }, "Conversations"),
    h("button", { class: "sb-btn sb-btn-ghost", onclick: onNew }, "New"),
  );
  const convList = h("ul", { class: "sb-chat-convs" });
  sidebar.appendChild(sideHeader);
  sidebar.appendChild(convList);

  const main = h("section", { class: "sb-chat-main" });
  const messagesEl = h("div", { class: "sb-chat-messages", onscroll: onMessagesScroll });
  const composer = h("form", { class: "sb-chat-composer", onsubmit: onSubmit });
  const modelPicker = h("select", { class: "sb-chat-model", onchange: onModelChange },
    ...MODEL_OPTIONS.map((m) =>
      h("option", { value: m, selected: m === state.model ? "selected" : null }, m),
    ),
  );
  const textarea = h("textarea", {
    class: "sb-chat-input",
    rows: "2",
    placeholder: "Type a message… (Cmd/Ctrl+Enter to send)",
    onkeydown: onComposerKey,
  });
  const sendBtn = h("button", { class: "sb-btn sb-btn-primary", type: "submit" }, "Send");
  const composerRow = h("div", { class: "sb-chat-composer-row" }, textarea, sendBtn);
  composer.appendChild(modelPicker);
  composer.appendChild(composerRow);
  main.appendChild(messagesEl);
  main.appendChild(composer);

  root.appendChild(sidebar);
  root.appendChild(main);

  // Initial load
  loadConversations().catch((err) => renderError("Failed to load conversations: " + err.message));
  renderMessages();

  // ── event handlers ─────────────────────────────────────────────

  function onNew() {
    state.currentId = null;
    state.messages = [];
    renderMessages();
    textarea.focus();
    highlightActive();
    subscribeRealtime();
  }

  function onMessagesScroll() {
    const nearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    state.autoScroll = nearBottom;
  }

  function onModelChange(e) {
    state.model = e.target.value;
    writeModel(state.model);
  }

  function onComposerKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      composer.requestSubmit();
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.streaming) return;
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    state.messages.push({ role: "user", content: text });
    const assistant = { role: "assistant", content: "" };
    state.messages.push(assistant);
    renderMessages();
    state.streaming = true;
    sendBtn.disabled = true;
    try {
      await streamCompletion(assistant);
      // Reload canonical ids from server.
      await loadConversations();
      if (state.currentId) await loadMessages(state.currentId, { quiet: true });
    } catch (err) {
      assistant.content += `\n\n_Error: ${err.message}_`;
      renderMessages();
    } finally {
      state.streaming = false;
      sendBtn.disabled = false;
    }
  }

  // ── data fetchers ──────────────────────────────────────────────

  async function loadConversations() {
    const data = await jsonFetch(
      `${apiBase}/conversations?workspace=${encodeURIComponent(workspace)}`,
    );
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    state.conversations = items
      .map((c) => ({
        id: c.id,
        title: c.title || "Untitled",
        updatedAt: c.updatedAt || c.createdAt || 0,
      }))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    renderConvList();
  }

  async function loadMessages(id, { quiet } = {}) {
    try {
      // Try dedicated /messages endpoint first, fall back to conversation payload.
      let msgs = null;
      try {
        const data = await jsonFetch(
          `${apiBase}/conversations/${encodeURIComponent(id)}/messages?workspace=${encodeURIComponent(workspace)}`,
        );
        msgs = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
      } catch {
        // fall through
      }
      if (!msgs) {
        const conv = await jsonFetch(
          `${apiBase}/conversations/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`,
        );
        msgs = Array.isArray(conv?.messages) ? conv.messages : [];
      }
      state.currentId = id;
      state.messages = msgs.map((m) => ({
        role: m.role || "assistant",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      }));
      renderMessages();
      highlightActive();
      subscribeRealtime();
    } catch (err) {
      if (!quiet) renderError("Failed to load messages: " + err.message);
    }
  }

  async function streamCompletion(assistantMsg) {
    const requestId =
      (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
        ? globalThis.crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.requestId = requestId;
    const body = {
      messages: state.messages
        .filter((m) => m !== assistantMsg)
        .map((m) => ({ role: m.role, content: m.content })),
      model: state.model,
      stream: true,
      workspace,
      conversationId: state.currentId || undefined,
      requestId,
    };
    const startedAt = (globalThis.performance?.now?.() ?? Date.now());
    let usage = null;
    let observedModel = state.model;
    let observedCost = null;
    const finalize = () => {
      const latencyMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
      pushChatSignalsToInspector({
        cost: typeof observedCost === "number" ? observedCost : undefined,
        latencyMs,
        model: observedModel,
        tokens: usage
          ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens }
          : undefined,
      });
    };
    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const parsed = parseSseLine(line);
          if (!parsed) continue;
          if (parsed.type === "done") return;
          if (parsed.type === "data" && parsed.data) {
            const data = parsed.data;
            if (data && typeof data === "object") {
              const u = data.usage || data.choices?.[0]?.usage;
              if (u && (u.prompt_tokens != null || u.completion_tokens != null)) usage = u;
              if (typeof data.model === "string") observedModel = data.model;
              const c = Number(data.costUsd ?? data.usage?.costUsd);
              if (Number.isFinite(c)) observedCost = c;
            }
            const delta = extractDelta(data);
            if (delta) {
              assistantMsg.content += delta;
              renderMessages({ appendOnly: true });
            }
          }
        }
      }
    } finally {
      finalize();
    }
  }

  function extractDelta(payload) {
    try {
      if (typeof payload === "string") return payload;
      const c = payload.choices && payload.choices[0];
      if (c?.delta?.content) return c.delta.content;
      if (typeof c?.text === "string") return c.text;
      if (typeof payload.content === "string") return payload.content;
      if (typeof payload.delta === "string") return payload.delta;
    } catch { /* noop */ }
    return "";
  }

  // ── realtime overlay (optional) ────────────────────────────────

  function subscribeRealtime() {
    if (rtUnsub) { try { rtUnsub(); } catch { /* noop */ } rtUnsub = null; }
    if (!state.currentId) return;
    const RTC = globalThis.RealtimeClient || (globalThis.SiskelbotShell && globalThis.SiskelbotShell.realtime);
    if (!RTC) return;
    let client = RTC;
    // If RealtimeClient is a class, we assume the shell exposes a shared instance elsewhere.
    if (typeof RTC === "function") return; // don't instantiate our own socket.
    try {
      const channel = `chat:${state.currentId}`;
      client.subscribe(channel, (ev) => {
        const p = ev && ev.payload;
        if (!p) return;
        if (p.requestId && p.requestId === state.requestId) return; // our own stream
        // Append foreign deltas to a transient assistant bubble.
        const last = state.messages[state.messages.length - 1];
        if (last && last.role === "assistant" && !last.content.endsWith("▍")) {
          last.content += p.delta || "";
        } else {
          state.messages.push({ role: "assistant", content: p.delta || "" });
        }
        renderMessages({ appendOnly: true });
      });
      rtUnsub = () => client.unsubscribe(`chat:${state.currentId}`);
    } catch { /* noop */ }
  }

  // ── rendering ──────────────────────────────────────────────────

  function renderConvList() {
    convList.innerHTML = "";
    if (state.conversations.length === 0) {
      convList.appendChild(h("li", { class: "sb-chat-empty" }, "No conversations yet."));
      return;
    }
    for (const c of state.conversations) {
      const li = h("li",
        {
          class: "sb-chat-conv" + (c.id === state.currentId ? " is-active" : ""),
          onclick: () => loadMessages(c.id),
        },
        h("div", { class: "sb-chat-conv-title" }, c.title),
        h("div", { class: "sb-chat-conv-ts" }, formatTs(c.updatedAt)),
      );
      convList.appendChild(li);
    }
  }

  function highlightActive() {
    for (const li of convList.querySelectorAll(".sb-chat-conv")) {
      li.classList.toggle("is-active", li._convId === state.currentId);
    }
    renderConvList();
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    if (state.messages.length === 0) {
      messagesEl.appendChild(h("div", { class: "sb-chat-placeholder" },
        "Start a new conversation by typing below."));
      return;
    }
    for (const m of state.messages) {
      const bubble = h("div", { class: `sb-chat-msg sb-chat-msg-${m.role}` });
      const body = h("div", { class: "sb-chat-msg-body" });
      body.innerHTML = renderMarkdown(m.content || "");
      bubble.appendChild(h("div", { class: "sb-chat-msg-role" }, m.role));
      bubble.appendChild(body);
      messagesEl.appendChild(bubble);
    }
    if (state.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderError(msg) {
    messagesEl.appendChild(h("div", { class: "sb-chat-error" }, msg));
  }

  function formatTs(v) {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function readModel() {
    try {
      const v = globalThis.localStorage?.getItem(MODEL_STORAGE_KEY);
      if (v && MODEL_OPTIONS.includes(v)) return v;
    } catch { /* noop */ }
    return MODEL_OPTIONS[0];
  }

  function writeModel(v) {
    try { globalThis.localStorage?.setItem(MODEL_STORAGE_KEY, v); } catch { /* noop */ }
  }

  // Return a teardown for shells that support it.
  return () => {
    if (rtUnsub) { try { rtUnsub(); } catch { /* noop */ } }
  };
}
