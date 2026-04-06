/**
 * SSE streaming handler — manages the streaming fetch for chat completions,
 * parses SSE chunks, tracks token timing, and integrates with agent traces.
 */

import {
  scheduleDom,
  announce,
  showNotice,
  clearNotice,
  setConnectionStatus,
  mapChatHttpError,
  haptic,
  getStorageHeaders,
  getSelectedWorkspace,
  API_ENDPOINT,
  MAX_RETRIES,
  RETRY_DELAY_MS,
} from './common.js';

import {
  renderAgentProgressHtml,
  renderAgentActivityBlock,
  createAssistantBubble,
  updateAssistantContent,
  removeTypingIndicator,
  addMessage,
  addTypingIndicator,
  formatAgentLimitsHud,
  attachViewRunButton,
  speakText,
  scrollToBottom,
} from './messages.js';

/* ------------------------------------------------------------------ */
/*  SSE chunk parser                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse a single SSE data line into a JSON object.
 * Returns null for [DONE] sentinel or unparseable lines.
 */
export function parseSSEChunk(dataLine) {
  if (dataLine === '[DONE]') return null;
  try {
    return JSON.parse(dataLine);
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Tool-swarm formatter                                               */
/* ------------------------------------------------------------------ */

export function formatToolSwarmMarkdown(data) {
  const parts = [];
  if (data && data.query) parts.push('**Query:** ' + data.query);
  const agg = data && data.aggregation;
  if (!Array.isArray(agg) || agg.length === 0) {
    return parts.join('\n\n') || '```json\n' + JSON.stringify(data, null, 2) + '\n```';
  }
  agg.forEach((r) => {
    parts.push('### ' + (r.specialist || 'specialist') + (r.success ? '' : ' (failed)'));
    if (r.error) parts.push('_' + String(r.error) + '_');
    const out = String(r.output || '').trim();
    if (out) {
      const cap = out.length > 12000 ? out.slice(0, 12000) + '\n\u2026' : out;
      parts.push('```\n' + cap + '\n```');
    }
  });
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  Tool-swarm request                                                 */
/* ------------------------------------------------------------------ */

export async function runToolSwarmRequest(userText, { config, messages, persistMessages, updatePlanTaskButtonState, addLocalNotification, getSelectedToolSwarmSpecialists, toolSwarmAllowExec }) {
  const sendBtn = document.getElementById('send');
  const promptInput = document.getElementById('prompt');
  const clientApiKeyInput = document.getElementById('client-api-key');

  sendBtn.disabled = true;
  clearNotice();
  setConnectionStatus('Tool swarm\u2026');
  addMessage('user', userText);
  promptInput.value = '';
  addTypingIndicator();
  const headers = { 'Content-Type': 'application/json' };
  const clientApiKey = clientApiKeyInput?.value?.trim();
  if (clientApiKey) headers.Authorization = 'Bearer ' + clientApiKey;
  if (config.authRequired) {
    const sh = getStorageHeaders();
    if (sh['x-user-api-key']) headers['x-user-api-key'] = sh['x-user-api-key'];
  }
  const specialists = getSelectedToolSwarmSpecialists();
  const allowExecution = toolSwarmAllowExec && toolSwarmAllowExec.checked === true;
  const workspace = getSelectedWorkspace();
  try {
    const res = await fetch('/v1/swarm', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: userText, specialists, allowExecution, workspace }),
    });
    removeTypingIndicator();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.hint || data.error || res.statusText;
      addMessage('assistant', '**Tool swarm failed**\n\n' + msg, null).classList.add('error-message');
      showNotice(msg, 'error', true);
      setConnectionStatus('Error');
      return;
    }
    const md = formatToolSwarmMarkdown(data);
    const metaParts = [];
    if (data.metrics && data.metrics.agentCount != null) metaParts.push(data.metrics.agentCount + ' specialists');
    if (data.metrics && data.metrics.durationMs != null) metaParts.push((data.metrics.durationMs / 1000).toFixed(1) + 's');
    const meta = metaParts.length ? metaParts.join(' \u00b7 ') : null;
    messages.push({ role: 'user', content: userText });
    messages.push({ role: 'assistant', content: md });
    persistMessages();
    addMessage('assistant', md, meta);
    if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
    if (typeof addLocalNotification === 'function') {
      addLocalNotification('swarm_completed', 'Tool swarm finished', (data.query || '').slice(0, 120));
    }
    setConnectionStatus(window.SiskelI18n && window.SiskelI18n.t ? window.SiskelI18n.t('status.ready') : 'Ready');
  } catch (err) {
    removeTypingIndicator();
    addMessage('assistant', '**Tool swarm failed**\n\n' + (err.message || 'Network error'), null).classList.add('error-message');
    showNotice(err.message || 'Request failed', 'error', true);
    setConnectionStatus('Error');
  } finally {
    sendBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Main streaming send                                                */
/* ------------------------------------------------------------------ */

/**
 * Start the main streaming chat request (SSE).
 *
 * @param {object} opts  All the state and callbacks needed by the streaming loop.
 */
export async function startStreamingSend(opts) {
  const {
    config,
    messages,
    buildApiMessages,
    persistMessages,
    getGenerationConfig,
    getAllowRecipeExecution,
    getSelectedSwarmLlmSpecialists,
    updatePlanTaskButtonState,
    attachedImages,
    clearAttachedImages,
    renderAttachedImages,
    supportsVision,
    attachBranchButton,
  } = opts;

  const modelInput = document.getElementById('model');
  const promptInput = document.getElementById('prompt');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const clientApiKeyInput = document.getElementById('client-api-key');
  const agentModeCheckbox = document.getElementById('agent-mode');
  const swarmModeCheckbox = document.getElementById('swarm-mode');
  const swarmParallelAgentsCheckbox = document.getElementById('swarm-parallel-agents');
  const autoSpeakCheckbox = document.getElementById('auto-speak');

  const model = modelInput.value.trim() || config.modelPlaceholder || 'model';
  const prompt = promptInput.value.trim();

  if (!prompt && !attachedImages.length) return;
  haptic('send');

  if (opts.activeAbortController) opts.activeAbortController.abort();
  const abortController = new AbortController();
  opts.activeAbortController = abortController;
  const signal = abortController.signal;
  opts.lastSubmittedPrompt = prompt;

  sendBtn.disabled = true;
  stopBtn.style.display = 'inline-block';
  clearNotice();
  setConnectionStatus('Connecting...');

  const displayPrompt = prompt + (attachedImages.length ? ' \ud83d\udcf7' : '');
  const userEl = addMessage('user', displayPrompt);
  if (typeof attachBranchButton === 'function') attachBranchButton(userEl);
  promptInput.value = '';

  const visionSupported = attachedImages.length > 0 && typeof supportsVision === 'function' && supportsVision(model, config.backend);
  const userContent = visionSupported && attachedImages.length
    ? [{ type: 'text', text: prompt }, ...attachedImages.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : prompt;
  const userMsg = { role: 'user', content: userContent };
  messages.push(userMsg);
  if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();

  let apiMessages = await buildApiMessages(prompt);
  const lastIdx = apiMessages.length - 1;
  if (visionSupported && lastIdx >= 0 && apiMessages[lastIdx]?.role === 'user') {
    apiMessages = [...apiMessages];
    apiMessages[lastIdx] = { ...apiMessages[lastIdx], content: userContent };
  }

  clearAttachedImages();
  if (typeof renderAttachedImages === 'function') renderAttachedImages();

  const isAgentMode = agentModeCheckbox?.checked === true;
  const isSwarmMode = swarmModeCheckbox?.checked === true;
  const workspace = getSelectedWorkspace();
  const payloadObj = {
    model: model,
    messages: apiMessages,
    stream: true,
    ...getGenerationConfig(),
  };
  if (isAgentMode) {
    payloadObj.agentMode = true;
    payloadObj.agentOptions = {
      allowExecution: getAllowRecipeExecution(),
      workspace: workspace,
    };
    if (isSwarmMode && swarmParallelAgentsCheckbox) {
      payloadObj.agentOptions.parallelAgents = swarmParallelAgentsCheckbox.checked === true;
    }
    if (isSwarmMode && config.swarmClientSpecialistsAllowed) {
      const roster = getSelectedSwarmLlmSpecialists();
      if (Array.isArray(roster) && roster.length) payloadObj.agentOptions.swarmSpecialists = roster;
    }
    const maxItEl = document.getElementById('agent-max-iterations');
    if (maxItEl && maxItEl.value && String(maxItEl.value).trim()) {
      const n = parseInt(maxItEl.value, 10);
      if (n >= 1) payloadObj.agentOptions.maxIterations = n;
    }
  } else {
    payloadObj.agentOptions = { workspace: workspace };
  }
  if (isSwarmMode) {
    payloadObj.swarmMode = true;
  }
  const payload = JSON.stringify(payloadObj);

  let lastError;
  let assistantSseStreaming = false;
  let ttfb;
  let streamStartTime;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      assistantSseStreaming = false;
      const headers = { 'Content-Type': 'application/json' };
      const clientApiKey = clientApiKeyInput?.value?.trim();
      if (clientApiKey) {
        headers.Authorization = `Bearer ${clientApiKey}`;
      }
      if (config.authRequired) {
        const sh = getStorageHeaders();
        if (sh['x-user-api-key']) headers['x-user-api-key'] = sh['x-user-api-key'];
      }
      ttfb = null;
      streamStartTime = performance.now();
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      });

      if (!res.ok) {
        let errData = {};
        try {
          errData = await res.json();
        } catch (_) {}
        const mapped = mapChatHttpError(res.status, errData);
        const isQuotaExceeded = res.status === 429 && errData.code === 'QUOTA_EXCEEDED';
        const isRetryable = (res.status >= 500 || (res.status === 429 && !isQuotaExceeded)) && attempt < MAX_RETRIES;
        if (isRetryable) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        if (res.status === 401) {
          showNotice(mapped.detail || mapped.summary, 'warning', true);
        }
        if (isQuotaExceeded) {
          showNotice(mapped.detail || mapped.summary, 'error', true);
        }
        throw new Error(mapped.summary + (mapped.detail ? ' \u2014 ' + mapped.detail : ''));
      }

      setConnectionStatus('Streaming...');
      assistantSseStreaming = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let assistantEl = null;
      let lastAgentActivity = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'agent_progress') {
                scheduleDom(function () {
                  if (!assistantEl) {
                    removeTypingIndicator();
                    assistantEl = createAssistantBubble('', null, renderAgentProgressHtml(parsed), assistantSseStreaming);
                  } else {
                    const strip = assistantEl.querySelector('.agent-progress-strip');
                    if (strip) strip.outerHTML = renderAgentProgressHtml(parsed);
                    else {
                      const header = assistantEl.querySelector('.message-header');
                      if (header) header.insertAdjacentHTML('afterend', renderAgentProgressHtml(parsed));
                    }
                  }
                });
                announce('Agent iteration ' + parsed.iteration);
                continue;
              }
              if (parsed.type === 'agent_activity') {
                lastAgentActivity = parsed;
                scheduleDom(function () {
                  const progressEl = assistantEl && assistantEl.querySelector('.agent-progress-strip');
                  if (progressEl) progressEl.remove();
                  const activityHtml = renderAgentActivityBlock(parsed.toolCalls || [], parsed.swarmSteps || [], parsed.iteration);
                  if (!assistantEl) {
                    removeTypingIndicator();
                    assistantEl = createAssistantBubble('', null, activityHtml, assistantSseStreaming);
                  } else {
                    const oldAct = assistantEl.querySelector('.agent-activity-block');
                    if (oldAct) oldAct.outerHTML = activityHtml;
                    else {
                      const header = assistantEl.querySelector('.message-header');
                      if (header) header.insertAdjacentHTML('afterend', activityHtml);
                    }
                  }
                });
                continue;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                if (ttfb === null) ttfb = Math.round(performance.now() - streamStartTime);
                content += delta;
                const metaLine = ttfb !== null ? `First token: ${ttfb}ms` : null;
                scheduleDom(function () {
                  if (!assistantEl) {
                    removeTypingIndicator();
                    assistantEl = createAssistantBubble(content, metaLine, null, assistantSseStreaming);
                  } else {
                    updateAssistantContent(assistantEl, content, metaLine, assistantSseStreaming);
                  }
                });
              }
            } catch (_) {}
          }
        }
      }

      assistantSseStreaming = false;
      let meta = ttfb !== null ? `First token: ${ttfb}ms` : null;
      const swarmAgents = res.headers.get('X-Swarm-Agents');
      const swarmDuration = res.headers.get('X-Swarm-Duration-Ms');
      const swarmParallel = res.headers.get('X-Swarm-Parallel');
      const swarmRosterSource = res.headers.get('X-Swarm-Roster-Source');
      if (swarmAgents || swarmDuration || swarmParallel || swarmRosterSource) {
        const parts = [];
        if (swarmParallel === '1') parts.push('parallel');
        if (swarmRosterSource === 'client') parts.push('custom roster');
        if (swarmAgents) parts.push(`${swarmAgents} agents`);
        if (swarmDuration) parts.push(`${Number(swarmDuration) / 1000}s`);
        const swarmMeta = parts.join(' \u00b7 ');
        meta = meta ? `${meta} \u00b7 ${swarmMeta}` : swarmMeta;
      }
      const hud = formatAgentLimitsHud(res.headers, lastAgentActivity);
      if (hud) meta = meta ? `${meta} \u00b7 ${hud}` : hud;
      if (assistantEl && meta) updateAssistantContent(assistantEl, content, meta, false);
      const runIdHdr = res.headers.get('X-Agent-Run-Id');
      if (assistantEl && runIdHdr) attachViewRunButton(assistantEl, runIdHdr);

      if (!content) {
        removeTypingIndicator();
        if (assistantEl) updateAssistantContent(assistantEl, '(No response)', meta, false);
        else assistantEl = createAssistantBubble('(No response)', meta, null, false);
      }

      messages.push({ role: 'assistant', content: content });
      persistMessages();
      setConnectionStatus(window.SiskelI18n && window.SiskelI18n.t ? window.SiskelI18n.t('status.ready') : 'Ready');
      haptic('success');
      if (autoSpeakCheckbox?.checked && content?.trim() && content !== '(No response)' && content !== '(Cancelled)') {
        const btn = assistantEl?.querySelector('.btn-speaker');
        if (btn) btn.classList.add('speaking');
        speakText(content);
      }
      break;
    } catch (err) {
      assistantSseStreaming = false;
      if (err.name === 'AbortError') {
        removeTypingIndicator();
        messages.pop(); // undo user message so they can retry
        const cancelledEl = createAssistantBubble('(Cancelled)', null, null, false);
        cancelledEl.querySelector('.message-content').style.fontStyle = 'italic';
        setConnectionStatus('Cancelled');
        break;
      }
      lastError = err;
      const isRetryable = err.message?.includes('fetch') || err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError');
      if (isRetryable && attempt < MAX_RETRIES) {
        setConnectionStatus(`Retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      removeTypingIndicator();
      const backendHint = config.backend === 'vllm' ? 'vLLM (vllm serve <model> --max-model-len 4096)' : config.backend === 'ollama' ? 'Ollama (ollama serve)' : config.backend === 'openai' ? 'OpenAI (OPENAI_API_KEY)' : config.backend;
      let modeHint = '';
      try {
        const swarmOn = swarmModeCheckbox && swarmModeCheckbox.checked;
        const agentOn = agentModeCheckbox && agentModeCheckbox.checked;
        if (swarmOn && !config.swarmEnabled) modeHint += '\n\nSwarm mode is on, but this host reports swarm disabled (ENABLE_AGENT_SWARM). Turn off Swarm in Settings or enable it on the server.';
        if (agentOn && lastError && /403|401/.test(String(lastError.message))) modeHint += '\n\nAgent mode may need an API key or sign-in for this deployment.';
      } catch (_) {}
      const errMsg = 'Error: ' + (lastError?.message || err.message) + '\n\nBackend: ' + backendHint + ' \u2014 visit /health to verify.' + modeHint;
      addMessage('assistant', errMsg, null).classList.add('error-message');
      showNotice(lastError?.message || err.message, 'error', true);
      setConnectionStatus('Error');
      haptic('error');
    }
  }

  opts.activeAbortController = null;
  sendBtn.disabled = false;
  stopBtn.style.display = 'none';
  scrollToBottom();
}

/* ------------------------------------------------------------------ */
/*  Expose on window for backward compat                               */
/* ------------------------------------------------------------------ */
window.SiskelStreaming = {
  parseSSEChunk,
  formatToolSwarmMarkdown,
  runToolSwarmRequest,
  startStreamingSend,
};
