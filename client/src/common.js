/**
 * Shared utilities used across multiple client pages.
 * Extracted during esbuild code-splitting (P0.3).
 */

/**
 * Escape a string for safe HTML insertion.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/**
 * Escape a string for use inside an HTML attribute value.
 * @param {string} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/*  Storage keys                                                       */
/* ------------------------------------------------------------------ */
export const STORAGE_KEY = 'siskelbot-messages';
export const STORAGE_VERSION = 1;
export const SESSION_API_KEY = 'siskelbot-api-key';
export const SESSION_USER_API_KEY = 'siskelbot-user-api-key';
export const SESSION_WORKSPACE_KEY = 'siskelbot-workspace';
export const SESSION_SEARCH_KEY = 'siskelbot-history-search';
export const CONTEXT_STORAGE_KEY = 'siskelbot-context';
export const CONTEXT_RAG_STORAGE_KEY = 'siskelbot-context-use-rag';
export const CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY = 'siskelbot-context-use-semantic-search';
export const RECIPES_STORAGE_KEY = 'siskelbot-recipes';
export const RECIPE_EXECUTION_STORAGE_KEY = 'siskelbot-allow-recipe-execution';
export const AGENT_MODE_STORAGE_KEY = 'siskelbot-agent-mode';
export const SWARM_MODE_STORAGE_KEY = 'siskelbot-swarm-mode';
export const SWARM_PARALLEL_STORAGE_KEY = 'siskelbot-swarm-parallel-agents';
export const SWARM_ROSTER_STORAGE_KEY = 'siskelbot-swarm-llm-roster-json';
export const AGENT_MAX_ITER_CLIENT_KEY = 'siskelbot-agent-max-iterations';
export const AGENT_PRESETS_STORAGE_KEY = 'siskelbot-agent-option-presets-v1';
export const EXECUTION_ENABLE_CONFIRMED_KEY = 'siskelbot-exec-enable-session';
export const CONVERSATIONS_STORAGE_KEY = 'siskelbot-conversations';
export const INSTALL_DISMISSED_KEY = 'siskelbot-install-dismissed';
export const NOTIFICATIONS_STORAGE_KEY = 'siskelbot-notifications';
export const ONBOARDING_DONE_KEY = 'siskelbot-onboarding-v3-done';
export const INTERACTION_MODE_STORAGE_KEY = 'siskelbot-interaction-mode';
export const TOOL_SWARM_SPECS_STORAGE_KEY = 'siskelbot-tool-swarm-specialists';
export const TOOL_SWARM_ALLOW_EXEC_KEY = 'siskelbot-tool-swarm-allow-exec';

export const MAX_CONVERSATIONS = 50;
export const MAX_NOTIFICATIONS = 100;
export const MAX_CHAT_DOM_MESSAGES = 120;
export const MAX_RETRIES = 2;
export const RETRY_DELAY_MS = 800;
export const API_ENDPOINT = '/v1/chat/completions';

/* ------------------------------------------------------------------ */
/*  DOM scheduling helper                                              */
/* ------------------------------------------------------------------ */
export const scheduleDom = (typeof window.SiskelRafBatcher !== 'undefined' && window.SiskelRafBatcher.create)
  ? window.SiskelRafBatcher.create()
  : function (fn) { fn(); };

/* ------------------------------------------------------------------ */
/*  Simple event bus for cross-module communication                    */
/* ------------------------------------------------------------------ */
const _bus = {};
export const eventBus = {
  on(event, fn) {
    (_bus[event] = _bus[event] || []).push(fn);
  },
  off(event, fn) {
    const list = _bus[event];
    if (!list) return;
    _bus[event] = list.filter(f => f !== fn);
  },
  emit(event, ...args) {
    const list = _bus[event];
    if (!list) return;
    list.forEach(fn => { try { fn(...args); } catch (e) { console.warn('eventBus error', event, e); } });
  }
};

/* ------------------------------------------------------------------ */
/*  Accessibility: live-region announcer                               */
/* ------------------------------------------------------------------ */
export function announce(message) {
  const liveRegion = document.getElementById('live-region');
  if (liveRegion) {
    liveRegion.textContent = '';
    requestAnimationFrame(() => {
      liveRegion.textContent = message;
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Notice banner helpers                                              */
/* ------------------------------------------------------------------ */
let _lastErrorMessage = '';

export function getLastErrorMessage() { return _lastErrorMessage; }

export function showNotice(message, variant = 'warning', opts = false) {
  _lastErrorMessage = message;
  const noticeText = document.getElementById('notice-text');
  const noticeBanner = document.getElementById('notice-banner');
  const retryLastBtn = document.getElementById('retry-last');
  if (!noticeText || !noticeBanner) return;
  noticeText.textContent = message;
  noticeBanner.className = `notice-banner visible ${variant}`;
  const canRetry = typeof opts === 'boolean' ? opts : (opts && opts.canRetry);
  const openSettings = opts && opts.openSettings;
  if (retryLastBtn) retryLastBtn.hidden = !canRetry;
  const openSettingsBtn = document.getElementById('notice-open-settings');
  if (openSettingsBtn) {
    openSettingsBtn.hidden = !openSettings;
    openSettingsBtn.onclick = () => {
      const settingsToggle = document.getElementById('settings-toggle');
      if (settingsToggle) settingsToggle.open = true;
      clearNotice();
    };
  }
}

export function clearNotice() {
  const noticeBanner = document.getElementById('notice-banner');
  const retryLastBtn = document.getElementById('retry-last');
  const noticeText = document.getElementById('notice-text');
  if (noticeBanner) noticeBanner.className = 'notice-banner';
  if (retryLastBtn) retryLastBtn.hidden = true;
  if (noticeText) noticeText.textContent = '';
}

export function setConnectionStatus(text) {
  const connectionStatus = document.getElementById('connection-status');
  if (connectionStatus) connectionStatus.textContent = text;
}

/* ------------------------------------------------------------------ */
/*  API / fetch helpers                                                */
/* ------------------------------------------------------------------ */
export function getStorageHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const userApiKeyInput = document.getElementById('user-api-key');
  const userKey = userApiKeyInput?.value?.trim();
  if (userKey) h['x-user-api-key'] = userKey;
  return h;
}

export function getStorageFetchOptions(extra) {
  const o = { headers: getStorageHeaders(), credentials: 'include', ...extra };
  return o;
}

export function getApiHeaders() {
  const h = getStorageHeaders();
  const clientApiKeyInput = document.getElementById('client-api-key');
  const key = clientApiKeyInput?.value?.trim();
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

export function getWorkspace() {
  return sessionStorage.getItem(SESSION_WORKSPACE_KEY) || 'default';
}

export function setWorkspace(id) {
  sessionStorage.setItem(SESSION_WORKSPACE_KEY, id || 'default');
}

export function getSelectedWorkspace() {
  const workspaceSelect = document.getElementById('workspace-select');
  return (workspaceSelect?.value || getWorkspace() || 'default');
}

export function mapChatHttpError(status, errData) {
  errData = errData || {};
  const code = errData.code;
  const extra = {
    QUOTA_EXCEEDED: 'Try another workspace or wait until the quota period resets.',
    AUTH_REQUIRED: 'Add a deployment or user API key in Settings, or sign in with OAuth.',
    AUTH_INVALID: 'Check the user API key in Settings.',
    NOT_AUTHENTICATED: 'Sign in or provide a valid API key.',
    FEATURE_DISABLED: errData.hint || 'This feature is disabled on the server.',
  };
  const summary = errData.message || errData.error || ('HTTP ' + status);
  const detail = extra[code] || errData.hint || '';
  return { summary, detail };
}

/* ------------------------------------------------------------------ */
/*  Haptics                                                            */
/* ------------------------------------------------------------------ */
export function haptic(type) {
  if (typeof navigator.vibrate !== 'function') return;
  if (type === 'send') navigator.vibrate(10);
  else if (type === 'success') navigator.vibrate([10, 50, 10]);
  else if (type === 'error') navigator.vibrate([20, 50, 20]);
}

/* ------------------------------------------------------------------ */
/*  i18n helper                                                        */
/* ------------------------------------------------------------------ */
export function t(key) {
  return (window.SiskelI18n && window.SiskelI18n.t) ? window.SiskelI18n.t(key) : '';
}

/* ------------------------------------------------------------------ */
/*  Expose on window for backward compat                               */
/* ------------------------------------------------------------------ */
window.SiskelCommon = {
  escapeHtml,
  escapeAttr,
  announce,
  showNotice,
  clearNotice,
  setConnectionStatus,
  getStorageHeaders,
  getStorageFetchOptions,
  getApiHeaders,
  getWorkspace,
  setWorkspace,
  getSelectedWorkspace,
  mapChatHttpError,
  haptic,
  scheduleDom,
  eventBus,
  t,
};
