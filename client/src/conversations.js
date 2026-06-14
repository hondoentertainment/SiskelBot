/**
 * Conversation management — load, save, delete, switch, search, branch,
 * and render conversation lists.
 */

import {
  escapeHtml,
  announce,
  showNotice,
  clearNotice,
  STORAGE_KEY,
  STORAGE_VERSION,
  CONVERSATIONS_STORAGE_KEY,
  MAX_CONVERSATIONS,
  SESSION_SEARCH_KEY,
} from './common.js';

import { addMessage } from './messages.js';

/* ------------------------------------------------------------------ */
/*  Conversation state                                                 */
/* ------------------------------------------------------------------ */

let _messages = [];
let _conversationMeta = { pinned: false, tags: [] };
let _currentConversationId = null;

/** Provide a reference to the shared messages array from chat.js */
export function bindState(state) {
  _messages = state.messages;
  _conversationMeta = state.conversationMeta;
  _currentConversationId = state.currentConversationId;
  return {
    get messages() { return _messages; },
    set messages(v) { _messages = v; state.messages = v; },
    get conversationMeta() { return _conversationMeta; },
    set conversationMeta(v) { _conversationMeta = v; state.conversationMeta = v; },
    get currentConversationId() { return _currentConversationId; },
    set currentConversationId(v) { _currentConversationId = v; state.currentConversationId = v; },
  };
}

/* Internal accessors — these are set once from chat.js init */
let _bound = null;
export function _setBound(b) { _bound = b; }

function msgs() { return _bound ? _bound.messages : _messages; }
// function setMsgs(v) { if (_bound) _bound.messages = v; else _messages = v; }
function meta() { return _bound ? _bound.conversationMeta : _conversationMeta; }
// function setMeta(v) { if (_bound) _bound.conversationMeta = v; else _conversationMeta = v; }
function convId() { return _bound ? _bound.currentConversationId : _currentConversationId; }
function setConvId(v) { if (_bound) _bound.currentConversationId = v; else _currentConversationId = v; }

/* ------------------------------------------------------------------ */
/*  Persistence helpers                                                */
/* ------------------------------------------------------------------ */

export function persistMessages(messages, conversationMeta, _currentConversationId) {
  const m = messages || msgs();
  const cm = conversationMeta || meta();
  try {
    const payload = {
      _version: STORAGE_VERSION,
      messages: m,
      pinned: cm.pinned,
      tags: Array.isArray(cm.tags) ? cm.tags : [],
    };
    if (m.length > 0 || cm.pinned || (cm.tags && cm.tags.length > 0)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (navigator.serviceWorker?.controller) {
      const convosPayload = { messages: m, pinned: cm.pinned, tags: cm.tags };
      try {
        const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
        const convos = raw ? JSON.parse(raw) : {};
        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_CONVOS', payload: { current: convosPayload, list: convos } });
      } catch (_) {}
    }
  } catch (e) {
    console.warn('SiskelBot: failed to persist messages', e);
  }
}

export function loadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { messages: parsed, pinned: false, tags: [] };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
      const mig = migrateMessagesPayload(parsed);
      return { messages: mig.messages, pinned: !!mig.pinned, tags: Array.isArray(mig.tags) ? mig.tags : [] };
    }
    return null;
  } catch (_) {
    return null;
  }
}

export function migrateMessagesPayload(payload) {
  if (!payload || typeof payload !== 'object') return { messages: [], pinned: false, tags: [] };
  const v = payload._version;
  if (v !== STORAGE_VERSION) {
    payload._version = STORAGE_VERSION;
    payload.pinned = payload.pinned || false;
    payload.tags = Array.isArray(payload.tags) ? payload.tags : [];
  }
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    pinned: !!payload.pinned,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
  };
}

/* ------------------------------------------------------------------ */
/*  Conversation CRUD                                                  */
/* ------------------------------------------------------------------ */

export function getConversationTitle(msgsArr) {
  if (!Array.isArray(msgsArr)) return 'Untitled';
  const first = msgsArr.find(m => m && m.role === 'user' && typeof m.content === 'string');
  const text = (first?.content || '').trim();
  return text ? text.slice(0, 60) + (text.length > 60 ? '...' : '') : 'Untitled';
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function saveConversations(list) {
  try {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length) localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(arr));
    else localStorage.removeItem(CONVERSATIONS_STORAGE_KEY);
  } catch (_) {}
}

export function saveCurrentToConversations(messages, conversationMeta, currentConversationId, setCurrentConversationId) {
  const m = messages || msgs();
  const cm = conversationMeta || meta();
  let cid = currentConversationId != null ? currentConversationId : convId();
  if (m.length === 0) return;
  const list = loadConversations();
  const title = getConversationTitle(m);
  const tags = Array.isArray(cm.tags) ? cm.tags : [];
  const pinned = !!cm.pinned;
  const now = new Date().toISOString();
  let conv = { id: cid, title, messages: [...m], pinned, tags, createdAt: now, updatedAt: now };
  if (cid) {
    const idx = list.findIndex(c => c && String(c.id) === String(cid));
    if (idx >= 0) {
      conv = { ...list[idx], ...conv, messages: [...m], title, pinned, tags, updatedAt: now };
      list[idx] = conv;
    } else {
      conv.id = conv.id || crypto.randomUUID();
      cid = conv.id;
      if (setCurrentConversationId) setCurrentConversationId(cid);
      else setConvId(cid);
      list.unshift(conv);
    }
  } else {
    conv.id = crypto.randomUUID();
    cid = conv.id;
    if (setCurrentConversationId) setCurrentConversationId(cid);
    else setConvId(cid);
    list.unshift(conv);
  }
  const deduped = list.reduce((acc, c) => {
    const id = c?.id;
    if (!id) return acc;
    const existing = acc.findIndex(x => String(x.id) === String(id));
    if (existing >= 0) acc[existing] = c;
    else acc.push(c);
    return acc;
  }, []);
  const trimmed = deduped.slice(0, MAX_CONVERSATIONS);
  saveConversations(trimmed);
}

/* ------------------------------------------------------------------ */
/*  Conversation switching                                             */
/* ------------------------------------------------------------------ */

/**
 * Switch to a conversation by ID.
 * Takes callbacks for updating UI state that lives in chat.js.
 */
export function switchToConversation(id, {
  messages, setMessages, conversationMeta, setConversationMeta,
  currentConversationId, setCurrentConversationId,
  persistMessagesFn, applySearchFilter, updatePlanTaskButtonState,
  updatePinTagUI, attachBranchButton,
}) {
  saveCurrentToConversations(messages, conversationMeta, currentConversationId, setCurrentConversationId);
  const list = loadConversations();
  const conv = list.find(c => c && String(c.id) === String(id));
  if (!conv || !Array.isArray(conv.messages)) return;

  const filtered = conv.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  setMessages(filtered);
  setConversationMeta({ pinned: !!conv.pinned, tags: Array.isArray(conv.tags) ? [...conv.tags] : [] });
  setCurrentConversationId(conv.id);

  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) {
    while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
    filtered.forEach(m => {
      const el = addMessage(m.role, m.content, null);
      if (typeof attachBranchButton === 'function' && el) attachBranchButton(el);
    });
  }
  if (typeof updatePinTagUI === 'function') updatePinTagUI();
  if (typeof persistMessagesFn === 'function') persistMessagesFn();
  if (typeof applySearchFilter === 'function') applySearchFilter();
  if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
  renderConversationsList(currentConversationId);
  announce('Switched conversation');
}

/* ------------------------------------------------------------------ */
/*  Conversation list rendering                                        */
/* ------------------------------------------------------------------ */

export function renderConversationsList(currentConversationId, onSwitch) {
  const listEl = document.getElementById('conversations-list');
  const searchEl = document.getElementById('conversations-search');
  const matchEl = document.getElementById('conversations-match-count');
  if (!listEl) return;
  const q = (searchEl?.value || '').trim().toLowerCase();
  let all = loadConversations();
  let filtered = all;
  if (q) {
    filtered = all.filter(c => {
      const title = (c?.title || '').toLowerCase();
      const tags = (c?.tags || []).join(' ').toLowerCase();
      return title.includes(q) || tags.includes(q);
    });
  }
  const cid = currentConversationId != null ? currentConversationId : convId();
  const slice = filtered.slice(0, MAX_CONVERSATIONS);
  if (slice.length === 0) {
    listEl.innerHTML = '<li class="empty">No conversations</li>';
    listEl.classList.add('empty');
  } else {
    listEl.classList.remove('empty');
    listEl.innerHTML = slice.map(c => {
      const title = escapeHtml((c.title || 'Untitled').slice(0, 50));
      const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
      const tags = (c.tags || []).slice(0, 5);
      const tagsHtml = tags.length ? `<div class="conversation-item-tags">${tags.map(t => `<span class="conversation-tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
      const active = cid && String(c.id) === String(cid) ? ' active' : '';
      return `<li class="conversation-item${active}" data-id="${escapeHtml(String(c.id))}" role="button" tabindex="0">` +
        `<span class="conversation-item-title">${title}</span>` +
        `<span class="conversation-item-meta">${escapeHtml(date)}</span>${tagsHtml}</li>`;
    }).join('');
    listEl.querySelectorAll('.conversation-item').forEach(li => {
      li.onclick = () => { if (typeof onSwitch === 'function') onSwitch(li.getAttribute('data-id')); };
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (typeof onSwitch === 'function') onSwitch(li.getAttribute('data-id')); } };
    });
  }
  if (matchEl) matchEl.textContent = q ? `${slice.length} / ${filtered.length}` : '';
}

/* ------------------------------------------------------------------ */
/*  Search filter                                                      */
/* ------------------------------------------------------------------ */

export function applySearchFilter() {
  const historySearch = document.getElementById('history-search');
  const chatContainer = document.getElementById('chat-container');
  const searchMatchCount = document.getElementById('search-match-count');

  const q = (historySearch?.value || '').trim().toLowerCase();
  try {
    if (q) sessionStorage.setItem(SESSION_SEARCH_KEY, q);
    else sessionStorage.removeItem(SESSION_SEARCH_KEY);
  } catch (_) {}
  const items = chatContainer?.querySelectorAll('.message') || [];
  let matchCount = 0;
  items.forEach((el) => {
    const contentEl = el.querySelector('.message-content');
    const text = (contentEl?.textContent || '').toLowerCase();
    const matches = !q || text.includes(q);
    el.style.display = matches ? '' : 'none';
    if (matches) matchCount++;
  });
  if (searchMatchCount) {
    searchMatchCount.textContent = q ? `${matchCount} / ${items.length}` : '';
  }
}

/* ------------------------------------------------------------------ */
/*  Pin / Tag UI                                                       */
/* ------------------------------------------------------------------ */

export function updatePinTagUI(conversationMeta) {
  const cm = conversationMeta || meta();
  const pinBtn = document.getElementById('pin-btn');
  const tagsInput = document.getElementById('tags-input');
  if (pinBtn) {
    pinBtn.classList.toggle('pinned', cm.pinned);
    pinBtn.textContent = cm.pinned ? '\u{1F4CC} Pinned' : '\u{1F4CC} Pin';
  }
  if (tagsInput) tagsInput.value = (cm.tags || []).join(', ');
}

/* ------------------------------------------------------------------ */
/*  Branch indicator                                                   */
/* ------------------------------------------------------------------ */

export function updateBranchIndicator(currentConversationId) {
  const indicator = document.getElementById('branch-indicator');
  const badge = document.getElementById('branch-badge');
  const selector = document.getElementById('branch-selector');
  const chatContainer = document.getElementById('chat-container');
  if (!indicator || !badge || !selector) return;

  const cid = currentConversationId != null ? currentConversationId : convId();
  if (!cid) {
    indicator.style.display = 'none';
    return;
  }

  const list = loadConversations();
  const current = list.find(c => c && String(c.id) === String(cid));
  const parentId = current?._isBranch ? current.parentConversationId : cid;

  const branches = list.filter(c => c && c._isBranch && String(c.parentConversationId) === String(parentId));
  const parent = list.find(c => c && String(c.id) === String(parentId));

  if (branches.length === 0) {
    indicator.style.display = 'none';
    return;
  }

  indicator.style.display = 'flex';
  if (current?._isBranch) {
    badge.textContent = '\u2B57 Branch';
    if (chatContainer) chatContainer.querySelectorAll('.message').forEach(m => m.classList.add('branched-conv'));
  } else {
    badge.textContent = branches.length + ' branch' + (branches.length > 1 ? 'es' : '');
  }

  selector.innerHTML = '';
  const parentOpt = document.createElement('option');
  parentOpt.value = parentId;
  parentOpt.textContent = (parent?.title || 'Original').slice(0, 40);
  if (String(cid) === String(parentId)) parentOpt.selected = true;
  selector.appendChild(parentOpt);

  branches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = ('\u2B57 ' + (b.label || b.title || 'Branch')).slice(0, 40);
    if (String(cid) === String(b.id)) opt.selected = true;
    selector.appendChild(opt);
  });
}

/* ------------------------------------------------------------------ */
/*  Server sync helpers                                                */
/* ------------------------------------------------------------------ */

export async function checkConversationsApi(onSwitch) {
  const conversationsServerActions = document.getElementById('conversations-server-actions');
  const conversationsSyncBtn = document.getElementById('conversations-sync-btn');
  const conversationsLoadBtn = document.getElementById('conversations-load-btn');
  try {
    const res = await fetch('/api/conversations', { method: 'HEAD' });
    if (res.ok && conversationsServerActions) {
      conversationsServerActions.style.display = 'flex';
      if (conversationsSyncBtn && !conversationsSyncBtn.dataset.wired) {
        conversationsSyncBtn.dataset.wired = '1';
        conversationsSyncBtn.onclick = async () => {
          try {
            loadConversations();
            saveCurrentToConversations();
            const list2 = loadConversations();
            const res2 = await fetch('/api/conversations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ conversations: list2 }),
            });
            if (res2.ok) {
              showNotice('Synced with server', 'warning', false);
              setTimeout(clearNotice, 2000);
            } else showNotice('Sync failed', 'error', false);
          } catch (e) { showNotice('Sync failed: ' + (e.message || 'network error'), 'error', false); }
        };
      }
      if (conversationsLoadBtn && !conversationsLoadBtn.dataset.wired) {
        conversationsLoadBtn.dataset.wired = '1';
        conversationsLoadBtn.onclick = async () => {
          try {
            const res2 = await fetch('/api/conversations');
            if (!res2.ok) { showNotice('Load failed', 'error', false); return; }
            const data = await res2.json();
            const list = Array.isArray(data.conversations) ? data.conversations : (Array.isArray(data) ? data : []);
            if (list.length === 0) { showNotice('No conversations on server', 'warning', false); return; }
            saveConversations(list);
            renderConversationsList(null, onSwitch);
            showNotice('Loaded from server', 'warning', false);
            setTimeout(clearNotice, 2000);
          } catch (e) { showNotice('Load failed: ' + (e.message || 'network error'), 'error', false); }
        };
      }
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/*  Export / Import                                                     */
/* ------------------------------------------------------------------ */

export function getExportPayload(messages, conversationMeta) {
  const m = messages || msgs();
  const cm = conversationMeta || meta();
  return {
    messages: m,
    pinned: cm.pinned,
    tags: Array.isArray(cm.tags) ? cm.tags : [],
    exportedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Expose on window for backward compat                               */
/* ------------------------------------------------------------------ */
window.SiskelConversations = {
  persistMessages,
  loadFromStorage,
  loadConversations,
  saveConversations,
  saveCurrentToConversations,
  switchToConversation,
  renderConversationsList,
  applySearchFilter,
  updatePinTagUI,
  updateBranchIndicator,
  getExportPayload,
  checkConversationsApi,
  getConversationTitle,
};
