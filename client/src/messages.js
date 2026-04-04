/**
 * Message rendering — renders chat messages, markdown, code blocks,
 * agent activity, typing indicator, and TTS.
 */

import {
  escapeHtml,
  scheduleDom,
  announce,
  showNotice,
  clearNotice,
  MAX_CHAT_DOM_MESSAGES,
} from './common.js';

/* ------------------------------------------------------------------ */
/*  Markdown rendering                                                 */
/* ------------------------------------------------------------------ */

export function renderAssistantMarkdown(text) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return escapeHtml(text);
  }
  const raw = marked.parse(text || '', { async: false });
  return DOMPurify.sanitize(raw || '', {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'a', 'ul', 'ol', 'li',
      'pre', 'code', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  Scroll & DOM pruning                                               */
/* ------------------------------------------------------------------ */

export function scrollToBottom() {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;
  scheduleDom(function () {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

export function pruneChatDom(maxKeep) {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;
  const cap = maxKeep || MAX_CHAT_DOM_MESSAGES;
  const msgs = chatContainer.querySelectorAll('.message');
  if (msgs.length <= cap) return;
  const drop = msgs.length - cap;
  for (let i = 0; i < drop; i++) {
    msgs[i].remove();
  }
}

/* ------------------------------------------------------------------ */
/*  Voice: Text-to-Speech                                              */
/* ------------------------------------------------------------------ */

const synth = window.speechSynthesis;
let currentUtterance = null;

export function speakText(text, onEnd) {
  if (!synth || !text || !text.trim()) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text.trim());
  u.rate = 1;
  u.pitch = 1;
  u.onend = () => {
    document.querySelectorAll('.btn-speaker.speaking').forEach(b => b.classList.remove('speaking'));
    if (onEnd) onEnd();
  };
  u.onerror = () => document.querySelectorAll('.btn-speaker.speaking').forEach(b => b.classList.remove('speaking'));
  currentUtterance = u;
  synth.speak(u);
}

export function attachSpeakerButton(msgEl) {
  const btn = msgEl.querySelector('.btn-speaker');
  const contentEl = msgEl.querySelector('.message-content');
  if (!btn || !contentEl) return;
  btn.addEventListener('click', () => {
    const text = contentEl.textContent || '';
    if (!text.trim()) return;
    if (btn.classList.contains('speaking')) {
      synth.cancel();
      btn.classList.remove('speaking');
      return;
    }
    document.querySelectorAll('.btn-speaker.speaking').forEach(b => b.classList.remove('speaking'));
    btn.classList.add('speaking');
    speakText(text);
  });
}

/* ------------------------------------------------------------------ */
/*  Agent activity rendering                                           */
/* ------------------------------------------------------------------ */

export function formatAgentLimitsHud(resHeaders, agentActivity) {
  if (!resHeaders || typeof resHeaders.get !== 'function') return '';
  const parts = [];
  const trunc = resHeaders.get('X-Agent-Truncated');
  const stopped = resHeaders.get('X-Agent-Stopped');
  const cite = resHeaders.get('X-Agent-Citations-Missing');
  const maxIter = resHeaders.get('X-Agent-Max-Iterations');
  const runId = resHeaders.get('X-Agent-Run-Id');
  if (trunc) parts.push('Limit: ' + trunc.replace(/_/g, ' '));
  if (stopped === 'stagnation') parts.push('Stopped: stagnation');
  if (cite === '1' || (agentActivity && agentActivity.citationWarning)) parts.push('Citations check');
  if (maxIter) parts.push('Max iter ' + maxIter);
  if (runId) parts.push('Run ' + runId.slice(0, 8) + '\u2026');
  const sr = agentActivity && agentActivity.stopReason;
  if (sr && sr !== 'model_finished') parts.push('Reason: ' + String(sr).replace(/_/g, ' '));
  return parts.length ? parts.join(' \u00b7 ') : '';
}

export function renderAgentProgressHtml(ev) {
  const tools = ev.tools || [];
  const toolEls = tools
    .map((t) => {
      const ok = t.validationError ? false : t.ok !== false;
      const cls = ok ? '' : ' ok-false';
      const label = escapeHtml(t.name || '?');
      const ms = t.durationMs != null ? `<span class="agent-activity-meta"> ${Number(t.durationMs)}ms</span>` : '';
      return `<li class="${cls}"><code>${label}</code>${ms}</li>`;
    })
    .join('');
  const llm = ev.llmMs != null ? `${ev.llmMs}ms` : '\u2014';
  const tw = ev.toolsWallMs != null ? `${ev.toolsWallMs}ms` : '\u2014';
  return `<div class="agent-progress-strip" role="status" aria-live="polite"><div class="agent-progress-title">Iteration ${escapeHtml(String(ev.iteration))} \u00b7 LLM ${escapeHtml(llm)} \u00b7 Tools wall ${escapeHtml(tw)}</div><ul class="agent-progress-tools">${toolEls}</ul></div>`;
}

export function renderAgentActivityBlock(toolCalls, swarmSteps, iteration) {
  if ((!toolCalls || !toolCalls.length) && (!swarmSteps || !swarmSteps.length)) return '';
  const parts = [];
  if (swarmSteps && swarmSteps.length) {
    parts.push('<div class="agent-activity-swarm"><span class="agent-activity-label">Swarm</span><ul>' +
      swarmSteps.map(s => `<li>${escapeHtml(s.specialist)} <span class="agent-activity-meta">${s.latencyMs}ms</span></li>`).join('') + '</ul></div>');
  }
  if (toolCalls && toolCalls.length) {
    parts.push('<div class="agent-activity-tools"><span class="agent-activity-label">Tools</span><ul>' +
      toolCalls.map((t) => {
        const dur = t.durationMs != null ? ` <span class="agent-activity-meta">${Number(t.durationMs)}ms</span>` : '';
        let argsHtml = '';
        if (t.args && typeof t.args === 'object' && Object.keys(t.args).length) {
          const j = escapeHtml(JSON.stringify(t.args, null, 2));
          argsHtml = ` <details style="margin-top:0.25rem;"><summary class="agent-activity-meta" style="cursor:pointer;">Args</summary><pre class="tool-io-json">${j}</pre><button type="button" class="tool-copy-btn">Copy JSON</button></details>`;
        }
        const flag = t.validationError ? ' <span class="agent-activity-meta">(validation)</span>' : t.error ? ' <span class="agent-activity-meta">(error)</span>' : '';
        return `<li><code>${escapeHtml(t.name || '')}</code>${dur}${flag}${argsHtml}</li>`;
      }).join('') + '</ul></div>');
  }
  return `<details class="agent-activity-block" open><summary>Agent activity ${iteration ? '(' + iteration + ' iter)' : ''}</summary>${parts.join('')}</details>`;
}

/* ------------------------------------------------------------------ */
/*  Message DOM creation                                               */
/* ------------------------------------------------------------------ */

export function addMessage(role, content, meta, { chatState } = {}) {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return null;
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.setAttribute('tabindex', '0');
  const label = role === 'user' ? 'User' : 'Assistant';
  const contentHtml = role === 'assistant' ? renderAssistantMarkdown(content) : escapeHtml(content);
  const contentClass = role === 'assistant' ? ' message-content markdown-rendered' : ' message-content';
  const branchBtnHtml = `<button class="btn-branch" type="button" aria-label="Branch conversation here" title="Branch conversation here">&#9095; Branch</button>`;
  const headerHtml = role === 'assistant'
    ? `<div class="message-header"><div class="message-label">${label}</div><button class="btn-speaker" type="button" aria-label="Read aloud" title="Read aloud">&#128266;</button>${branchBtnHtml}</div>`
    : `<div class="message-header"><div class="message-label">${label}</div>${branchBtnHtml}</div>`;
  el.innerHTML = `
    ${headerHtml}
    <div class="${contentClass.trim()}">${contentHtml}</div>
    ${meta ? `<div class="message-meta">${escapeHtml(meta)}</div>` : ''}
  `;
  chatContainer.appendChild(el);
  pruneChatDom();
  if (role === 'assistant') attachSpeakerButton(el);
  scrollToBottom();
  announce(`${label} message added`);
  return el;
}

export function addTypingIndicator() {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return null;
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.id = 'typing-indicator';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="message-label">Assistant</div>
    <div class="message-content typing-indicator">
      <span></span><span></span><span></span> typing...
    </div>
  `;
  chatContainer.appendChild(el);
  scrollToBottom();
  return el;
}

export function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

export function createAssistantBubble(content, meta, activityHtml, assistantSseStreaming) {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return null;
  const el = document.createElement('div');
  el.className = 'message assistant';
  const bodyClass = assistantSseStreaming ? 'message-content' : 'message-content markdown-rendered';
  const bodyHtml = assistantSseStreaming ? escapeHtml(content || '') : renderAssistantMarkdown(content || '');
  el.innerHTML = `
    <div class="message-header"><div class="message-label">Assistant</div><button class="btn-speaker" type="button" aria-label="Read aloud" title="Read aloud">&#128266;</button></div>
    ${activityHtml || ''}
    <div class="${bodyClass}">${bodyHtml}</div>
    ${meta ? `<div class="message-meta">${escapeHtml(meta)}</div>` : ''}
  `;
  chatContainer.appendChild(el);
  pruneChatDom();
  attachSpeakerButton(el);
  scrollToBottom();
  return el;
}

export function updateAssistantContent(el, content, meta, assistantSseStreaming) {
  const contentEl = el.querySelector('.message-content');
  if (!contentEl) return;
  const metaEl = el.querySelector('.message-meta');
  if (assistantSseStreaming) {
    contentEl.textContent = content || '';
    contentEl.classList.remove('typing-indicator', 'markdown-rendered');
  } else {
    contentEl.innerHTML = renderAssistantMarkdown(content);
    contentEl.classList.remove('typing-indicator');
    contentEl.classList.add('markdown-rendered');
  }
  if (meta) {
    if (metaEl) metaEl.textContent = meta;
    else {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'message-meta';
      metaDiv.textContent = meta;
      el.appendChild(metaDiv);
    }
  }
  scrollToBottom();
  announce('Assistant message updated');
}

/* ------------------------------------------------------------------ */
/*  Trajectory / run details                                           */
/* ------------------------------------------------------------------ */

export function showTrajectoryJsonModal(runId) {
  const modal = document.getElementById('trajectory-json-modal');
  const pre = document.getElementById('trajectory-json-body');
  if (!modal || !pre || !runId) return;
  pre.textContent = 'Loading\u2026';
  modal.style.display = 'flex';
  fetch('/api/agent/trajectory/' + encodeURIComponent(runId), getStorageFetchOptionsCompat())
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j }; }); })
    .then(function (x) {
      pre.textContent = JSON.stringify(x.j, null, 2);
    })
    .catch(function () { pre.textContent = 'Failed to load trajectory.'; });
}

function getStorageFetchOptionsCompat() {
  if (typeof window.SiskelCommon !== 'undefined' && window.SiskelCommon.getStorageFetchOptions) {
    return window.SiskelCommon.getStorageFetchOptions();
  }
  return { headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
}

export function attachViewRunButton(assistantEl, runId) {
  if (!assistantEl || !runId) return;
  const header = assistantEl.querySelector('.message-header');
  if (!header || header.querySelector('.btn-view-run')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-view-run';
  btn.textContent = 'Run details';
  btn.setAttribute('aria-label', 'View agent run JSON');
  btn.onclick = function () { showTrajectoryJsonModal(runId); };
  header.appendChild(btn);
}

/* ------------------------------------------------------------------ */
/*  Expose on window for backward compat                               */
/* ------------------------------------------------------------------ */
window.SiskelMessages = {
  renderAssistantMarkdown,
  scrollToBottom,
  pruneChatDom,
  speakText,
  attachSpeakerButton,
  formatAgentLimitsHud,
  renderAgentProgressHtml,
  renderAgentActivityBlock,
  addMessage,
  addTypingIndicator,
  removeTypingIndicator,
  createAssistantBubble,
  updateAssistantContent,
  showTrajectoryJsonModal,
  attachViewRunButton,
};
