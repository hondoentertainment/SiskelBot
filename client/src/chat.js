    (function initI18n() {
      if (window.SiskelI18n) {
        SiskelI18n.init().then(function() {
          var sel = document.getElementById('locale-select');
          if (sel) {
            sel.addEventListener('change', function() {
              SiskelI18n.setLocale(sel.value);
            });
          }
        });
      }
    })();
    const API = '/v1/chat/completions';
    const STORAGE_KEY = 'siskelbot-messages';
    const STORAGE_VERSION = 1;
    const SESSION_API_KEY = 'siskelbot-api-key';
    const SESSION_USER_API_KEY = 'siskelbot-user-api-key';
    const SESSION_WORKSPACE_KEY = 'siskelbot-workspace';
    const SESSION_SEARCH_KEY = 'siskelbot-history-search';
    const CONTEXT_STORAGE_KEY = 'siskelbot-context';
    const CONTEXT_RAG_STORAGE_KEY = 'siskelbot-context-use-rag';
    const CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY = 'siskelbot-context-use-semantic-search';
    const RECIPES_STORAGE_KEY = 'siskelbot-recipes';
    const RECIPE_EXECUTION_STORAGE_KEY = 'siskelbot-allow-recipe-execution';
    const AGENT_MODE_STORAGE_KEY = 'siskelbot-agent-mode';
    const SWARM_MODE_STORAGE_KEY = 'siskelbot-swarm-mode';
    const SWARM_PARALLEL_STORAGE_KEY = 'siskelbot-swarm-parallel-agents';
    const SWARM_ROSTER_STORAGE_KEY = 'siskelbot-swarm-llm-roster-json';
    const AGENT_MAX_ITER_CLIENT_KEY = 'siskelbot-agent-max-iterations';
    const AGENT_PRESETS_STORAGE_KEY = 'siskelbot-agent-option-presets-v1';
    const EXECUTION_ENABLE_CONFIRMED_KEY = 'siskelbot-exec-enable-session';
    const CONVERSATIONS_STORAGE_KEY = 'siskelbot-conversations';
    const INSTALL_DISMISSED_KEY = 'siskelbot-install-dismissed';
    const NOTIFICATIONS_STORAGE_KEY = 'siskelbot-notifications';
    const MAX_CONVERSATIONS = 50;
    // const MAX_NOTIFICATIONS = 100;
    const ONBOARDING_DONE_KEY = 'siskelbot-onboarding-v3-done';
    const MAX_CHAT_DOM_MESSAGES = 120;
    const scheduleDom = (typeof SiskelRafBatcher !== 'undefined' && SiskelRafBatcher.create)
      ? SiskelRafBatcher.create()
      : function (fn) { fn(); };
    if (window.SiskelI18n) SiskelI18n.init();

    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
      chatContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.tool-copy-btn');
        if (!btn || !chatContainer.contains(btn)) return;
        const pre = btn.previousElementSibling;
        const text = pre && pre.classList && pre.classList.contains('tool-io-json') ? pre.textContent : '';
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            if (typeof showNotice === 'function') {
              showNotice('JSON copied', 'warning', false);
              setTimeout(clearNotice, 1500);
            }
          }).catch(() => {
            if (typeof showNotice === 'function') showNotice('Copy failed', 'error', false);
          });
        }
      });
    }
    const promptInput = document.getElementById('prompt');
    const sendBtn = document.getElementById('send');
    const clearBtn = document.getElementById('clear-btn');
    const modelInput = document.getElementById('model');
    const backendBadge = document.getElementById('backend-badge');
    const modelPresetsDatalist = document.getElementById('model-presets');
    const profileSelect = document.getElementById('profile-select');
    const templateSelect = document.getElementById('template-select');
    const systemPromptTextarea = document.getElementById('system-prompt');
    const historySearch = document.getElementById('history-search');
    const searchMatchCount = document.getElementById('search-match-count');
    const pinBtn = document.getElementById('pin-btn');
    const tagsInput = document.getElementById('tags-input');
    const stopBtn = document.getElementById('stop');
    const temperatureInput = document.getElementById('temperature');
    const topPInput = document.getElementById('top-p');
    const maxTokensInput = document.getElementById('max-tokens');
    const clientApiKeyInput = document.getElementById('client-api-key');
    const userApiKeyInput = document.getElementById('user-api-key');
    const workspaceSelect = document.getElementById('workspace-select');
    const noticeBanner = document.getElementById('notice-banner');
    const noticeText = document.getElementById('notice-text');
    const retryLastBtn = document.getElementById('retry-last');
    const dismissNoticeBtn = document.getElementById('dismiss-notice');
    const liveRegion = document.getElementById('live-region');
    const connectionStatus = document.getElementById('connection-status');

    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 800;

    let config = { backend: 'vllm', modelPresets: [], modelPlaceholder: 'meta-llama/Llama-3-8B-Instruct' };
    let activeAbortController = null;
    let lastSubmittedPrompt = '';
    // let lastErrorMessage = '';

    let conversationMeta = { pinned: false, tags: [] };
    let attachedImages = [];
    let currentConversationId = null;

    function persistMessages() {
      try {
        const payload = {
          _version: STORAGE_VERSION,
          messages: messages,
          pinned: conversationMeta.pinned,
          tags: Array.isArray(conversationMeta.tags) ? conversationMeta.tags : [],
        };
        if (messages.length > 0 || conversationMeta.pinned || (conversationMeta.tags && conversationMeta.tags.length > 0)) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
        if (navigator.serviceWorker?.controller) {
          const convosPayload = { messages, pinned: conversationMeta.pinned, tags: conversationMeta.tags };
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

    function loadFromStorage() {
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

    function migrateMessagesPayload(payload) {
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

    function announce(message) {
      if (liveRegion) {
        liveRegion.textContent = '';
        requestAnimationFrame(() => {
          liveRegion.textContent = message;
        });
      }
    }

    function showNotice(message, variant = 'warning', opts = false) {
      // lastErrorMessage = message;
      noticeText.textContent = message;
      noticeBanner.className = `notice-banner visible ${variant}`;
      const canRetry = typeof opts === 'boolean' ? opts : (opts && opts.canRetry);
      const openSettings = opts && opts.openSettings;
      retryLastBtn.hidden = !canRetry;
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

    function clearNotice() {
      noticeBanner.className = 'notice-banner';
      retryLastBtn.hidden = true;
      noticeText.textContent = '';
    }

    function setConnectionStatus(text) {
      connectionStatus.textContent = text;
    }

    function getGenerationConfig() {
      return {
        temperature: Number(temperatureInput.value || config.defaultGenerationConfig?.temperature || 0.7),
        top_p: Number(topPInput.value || config.defaultGenerationConfig?.top_p || 0.95),
        max_tokens: Number(maxTokensInput.value || config.defaultGenerationConfig?.max_tokens || 512),
      };
    }

    let sessionUser = null;

    async function loadAuthMe() {
      try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          sessionUser = { userId: data.userId, provider: data.provider };
          return true;
        }
      } catch (_) {}
      sessionUser = null;
      return false;
    }

    function updateOAuthUI() {
      const wrap = document.getElementById('user-api-key-wrap');
      const oauthSection = document.getElementById('oauth-auth-section');
      const oauthButtons = document.getElementById('oauth-buttons');
      const oauthSignedIn = document.getElementById('oauth-signed-in');
      const oauthUserLabel = document.getElementById('oauth-user-label');
      const logoutBtn = document.getElementById('oauth-logout-btn');
      if (!wrap || !config.authRequired) return;
      wrap.style.display = '';
      const providers = config.oauthProviders || {};
      const hasOAuth = providers.github || providers.google;
      if (hasOAuth && oauthSection) {
        oauthSection.style.display = '';
        if (sessionUser) {
          if (oauthButtons) oauthButtons.style.display = 'none';
          if (oauthSignedIn) {
            oauthSignedIn.style.display = '';
            if (oauthUserLabel) oauthUserLabel.textContent = 'Signed in as ' + (sessionUser.userId || '').slice(0, 24) + (sessionUser.provider ? ' (' + sessionUser.provider + ')' : '');
          }
        } else {
          if (oauthButtons) {
            oauthButtons.style.display = 'flex';
            oauthButtons.innerHTML = '';
            if (providers.github) {
              const b = document.createElement('a');
              b.href = '/auth/github';
              b.className = 'header-button';
              b.textContent = 'Sign in with GitHub';
              b.style.textDecoration = 'none';
              oauthButtons.appendChild(b);
            }
            if (providers.google) {
              const b = document.createElement('a');
              b.href = '/auth/google';
              b.className = 'header-button';
              b.textContent = 'Sign in with Google';
              b.style.textDecoration = 'none';
              oauthButtons.appendChild(b);
            }
          }
          if (oauthSignedIn) oauthSignedIn.style.display = 'none';
        }
      }
      if (logoutBtn) logoutBtn.onclick = () => { window.location.href = '/auth/logout'; };
    }

    async function loadConfig() {
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('auth_error') === '1') {
          showNotice((window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('error.authCancelled') : 'Sign-in was cancelled or failed. Try again or use API key.'), 'warning', false);
          window.history.replaceState({}, '', window.location.pathname);
        } else if (params.get('auth_error') === 'session') {
          showNotice((window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('error.sessionNotAvailable') : 'Session not available. Set SESSION_SECRET when using OAuth.'), 'error', false);
          window.history.replaceState({}, '', window.location.pathname);
        }
        const res = await fetch('/config');
        if (res.ok) {
          config = await res.json();
          backendBadge.textContent = config.backend;
          modelInput.placeholder = `Model (e.g. ${config.modelPlaceholder})`;
          if (!modelInput.value && config.modelPlaceholder) modelInput.value = config.modelPlaceholder;
          modelPresetsDatalist.innerHTML = (config.modelPresets || []).map(m => `<option value="${m}">`).join('');
          temperatureInput.value = config.defaultGenerationConfig?.temperature ?? 0.7;
          topPInput.value = config.defaultGenerationConfig?.top_p ?? 0.95;
          maxTokensInput.value = config.defaultGenerationConfig?.max_tokens ?? 512;
          if (config.productionHint) {
            showNotice(config.productionHint, 'warning', false);
          }
          if (config.requiresApiKey) {
            clientApiKeyInput.placeholder = 'Required for this deployment';
          }
          if (config.authRequired) {
            await loadAuthMe();
            updateOAuthUI();
            loadWorkspaces();
            const workspaceDetails = document.getElementById('workspace-details');
            if (workspaceDetails) workspaceDetails.style.display = '';
          }
          if (typeof updateSwarmSectionVisibility === 'function') updateSwarmSectionVisibility();
          if (typeof populateSwarmLlmRosterSpecialists === 'function') populateSwarmLlmRosterSpecialists();
          if (typeof window.refreshAgentServerDefaultsHint === 'function') window.refreshAgentServerDefaultsHint(config);
          if (typeof initInteractionModes === 'function') initInteractionModes();
          if (typeof maybeShowOnboarding === 'function') maybeShowOnboarding();
          if (typeof refreshSettingsDiagnostics === 'function') refreshSettingsDiagnostics();
        }
      } catch (_) {}
    }
    loadConfig();

    function getStorageHeaders() {
      const h = { 'Content-Type': 'application/json' };
      const userKey = userApiKeyInput?.value?.trim();
      if (userKey) h['x-user-api-key'] = userKey;
      return h;
    }
    function getStorageFetchOptions(extra) {
      const o = { headers: getStorageHeaders(), credentials: 'include', ...extra };
      return o;
    }
    function getWorkspace() {
      return sessionStorage.getItem(SESSION_WORKSPACE_KEY) || 'default';
    }
    function setWorkspace(id) {
      sessionStorage.setItem(SESSION_WORKSPACE_KEY, id || 'default');
    }
    function getSelectedWorkspace() {
      return (workspaceSelect?.value || getWorkspace() || 'default');
    }

    function mapChatHttpError(status, errData) {
      errData = errData || {};
      const code = errData.code || errData.error?.code;
      const extra = {
        QUOTA_EXCEEDED: 'Try another workspace or wait until the quota period resets.',
        PLAN_UPGRADE_REQUIRED: 'This feature requires a higher plan. Upgrade on the pricing page.',
        AUTH_REQUIRED: 'Add a deployment or user API key in Settings, or sign in with OAuth.',
        AUTH_INVALID: 'Check the user API key in Settings.',
        NOT_AUTHENTICATED: 'Sign in or provide a valid API key.',
        FEATURE_DISABLED: errData.hint || 'This feature is disabled on the server.',
      };
      const summary = errData.message || errData.error || ('HTTP ' + status);
      const detail = extra[code] || errData.hint || '';
      return { summary, detail };
    }

    function maybeShowOnboarding() {
      try {
        if (localStorage.getItem(ONBOARDING_DONE_KEY) === '1') return;
        const m = document.getElementById('onboarding-modal');
        if (!m) return;
        m.style.display = 'flex';
        const mh = document.getElementById('onboarding-metrics-hint');
        if (mh && config && config.prometheusEnabled) {
          mh.style.display = 'block';
          mh.textContent = 'Operators: Prometheus metrics at ' + (config.prometheusPath || '/metrics') + ' (ENABLE_METRICS=1).';
        }
        document.getElementById('onboarding-test-health')?.focus();
      } catch (_) {}
    }

    function dismissOnboarding() {
      try {
        localStorage.setItem(ONBOARDING_DONE_KEY, '1');
        const m = document.getElementById('onboarding-modal');
        if (m) m.style.display = 'none';
      } catch (_) {}
    }

    async function refreshSettingsDiagnostics() {
      const kEl = document.getElementById('settings-knowledge-count');
      const slo = document.getElementById('settings-slo-hint');
      const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      if (kEl) {
        try {
          const r = await fetch('/api/knowledge/status?workspace=' + encodeURIComponent(ws));
          if (r.ok) {
            const d = await r.json();
            kEl.textContent = 'Knowledge: ' + d.documentCount + ' document(s) indexed in workspace "' + d.workspace + '".';
          } else {
            kEl.textContent = 'Knowledge: could not load status.';
          }
        } catch (_) {
          kEl.textContent = 'Knowledge: could not load status.';
        }
      }
      if (slo && config) {
        if (config.prometheusEnabled) {
          slo.style.display = 'block';
          slo.textContent = 'SLO/metrics: scrape ' + (config.prometheusPath || '/metrics') + ' with Prometheus.';
        } else {
          slo.style.display = 'none';
        }
      }
      const ul = document.getElementById('settings-agent-runs-list');
      if (!ul) return;
      ul.innerHTML = '';
      if (!config || !config.agentTrajectoryApi) {
        ul.innerHTML = '<li>Trajectory API off on this host</li>';
        return;
      }
      try {
        const r = await fetch('/api/agent/trajectories?workspace=' + encodeURIComponent(ws) + '&limit=12', getStorageFetchOptions());
        if (!r.ok) {
          ul.innerHTML = '<li>Could not list runs (sign in or set API key)</li>';
          return;
        }
        const data = await r.json();
        const items = data.items || [];
        if (!items.length) {
          ul.innerHTML = '<li>No recent runs in memory/store</li>';
          return;
        }
        items.forEach(function (it) {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-view-run';
          btn.textContent = (it.runId || '').slice(0, 8) + '…';
          btn.title = it.runId;
          btn.onclick = function () { showTrajectoryJsonModal(it.runId); };
          li.appendChild(btn);
          li.appendChild(document.createTextNode(' · ' + (it.stepCount || 0) + ' steps'));
          const sid = it.sessionId || it.payload?.sessionId || it.runId;
          if (sid) {
            const op = document.createElement('a');
            op.href = '/app#/runs/' + encodeURIComponent(sid);
            op.textContent = 'Operator';
            op.style.marginLeft = '0.35rem';
            op.style.color = '#3dcf9a';
            li.appendChild(op);
          }
          ul.appendChild(li);
        });
      } catch (_) {
        ul.innerHTML = '<li>List failed</li>';
      }
    }

    function showTrajectoryJsonModal(runId) {
      const modal = document.getElementById('trajectory-json-modal');
      const pre = document.getElementById('trajectory-json-body');
      if (!modal || !pre || !runId) return;
      pre.textContent = 'Loading…';
      modal.style.display = 'flex';
      fetch('/api/agent/trajectory/' + encodeURIComponent(runId), getStorageFetchOptions())
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j }; }); })
        .then(function (x) {
          pre.textContent = JSON.stringify(x.j, null, 2);
        })
        .catch(function () { pre.textContent = 'Failed to load trajectory.'; });
    }

    function attachViewRunButton(assistantEl, runId) {
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

    document.getElementById('onboarding-dismiss')?.addEventListener('click', dismissOnboarding);
    document.getElementById('onboarding-test-health')?.addEventListener('click', async function () {
      const st = document.getElementById('onboarding-health-status');
      if (st) st.textContent = 'Checking…';
      try {
        const r = await fetch('/health');
        const ok = r.ok;
        const t = await r.text().catch(function () { return ''; });
        if (st) st.textContent = ok ? 'Connection OK (HTTP ' + r.status + ').' : 'Health check failed (' + r.status + '). ' + t.slice(0, 120);
      } catch (_) {
        if (st) st.textContent = 'Could not reach the server. Is it running?';
      }
    });
    document.getElementById('trajectory-json-close')?.addEventListener('click', function () {
      const modal = document.getElementById('trajectory-json-modal');
      if (modal) modal.style.display = 'none';
    });
    document.getElementById('trajectory-json-copy')?.addEventListener('click', function () {
      const pre = document.getElementById('trajectory-json-body');
      if (!pre) return;
      navigator.clipboard.writeText(pre.textContent || '').then(function () {
        showNotice('Copied trajectory JSON', 'warning', false);
        setTimeout(clearNotice, 1500);
      }).catch(function () {});
    });
    document.getElementById('settings-refresh-diagnostics')?.addEventListener('click', function () { refreshSettingsDiagnostics(); });
    document.getElementById('settings-toggle')?.addEventListener('toggle', function () {
      if (this.open) refreshSettingsDiagnostics();
    });

    async function loadWorkspaces() {
      if (!workspaceSelect || !config.authRequired) return;
      try {
        const res = await fetch('/api/workspaces', getStorageFetchOptions());
        if (res.ok) {
          const data = await res.json();
          const items = data.items || [];
          const cur = getWorkspace();
          workspaceSelect.innerHTML = items.map(w => `<option value="${w.id}" data-type="${w.type || 'personal'}" ${w.id === cur ? 'selected' : ''}>${escapeHtml(w.name || w.id)}</option>`).join('');
          if (items.length > 0 && !items.find(w => w.id === cur)) setWorkspace('default');
          const st = document.getElementById('settings-toggle');
          if (st && st.open && typeof window.loadWorkspaceAgentSettingsPanel === 'function') window.loadWorkspaceAgentSettingsPanel();
        }
      } catch (_) {}
    }

    // Phase 63–65: Server agent-default hint + workspace agent settings UI
    (function initWorkspaceAgentSettingsPanel() {
      const hintEl = document.getElementById('agent-server-defaults-hint');
      const systemTa = document.getElementById('workspace-agent-system-prompt');
      const memoryTa = document.getElementById('workspace-agent-memory-lines');
      const loadBtn = document.getElementById('workspace-agent-settings-load');
      const saveBtn = document.getElementById('workspace-agent-settings-save');
      const statusEl = document.getElementById('workspace-agent-settings-status');
      const settingsToggle = document.getElementById('settings-toggle');

      function stMsg(key) {
        return (window.SiskelI18n && SiskelI18n.t) ? SiskelI18n.t('settings.' + key) : '';
      }

      async function loadPanel() {
        if (!systemTa || !memoryTa || !statusEl) return;
        const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        statusEl.textContent = '';
        try {
          const res = await fetch('/api/workspaces/' + encodeURIComponent(ws) + '/agent-settings', getStorageFetchOptions());
          if (!res.ok) {
            statusEl.textContent = stMsg('workspaceAgentLoadError');
            return;
          }
          const data = await res.json();
          systemTa.value = data.defaultSystemPrompt || '';
          memoryTa.value = (Array.isArray(data.memorySnippets) ? data.memorySnippets : []).join('\n');
          statusEl.textContent = stMsg('workspaceAgentLoaded');
        } catch (_) {
          statusEl.textContent = stMsg('workspaceAgentLoadError');
        }
      }

      async function savePanel() {
        if (!systemTa || !memoryTa || !statusEl) return;
        const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        const lines = memoryTa.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        statusEl.textContent = '';
        try {
          const res = await fetch('/api/workspaces/' + encodeURIComponent(ws) + '/agent-settings', {
            ...getStorageFetchOptions(),
            method: 'PUT',
            body: JSON.stringify({
              defaultSystemPrompt: systemTa.value.trim(),
              memorySnippets: lines,
            }),
          });
          let data = {};
          try { data = await res.json(); } catch (_) {}
          if (!res.ok) {
            const hint = (data.hint || data.error || '').toLowerCase();
            if (res.status === 403 && hint.indexOf('viewer') !== -1)
              statusEl.textContent = stMsg('workspaceAgentViewerError');
            else
              statusEl.textContent = stMsg('workspaceAgentSaveError');
            return;
          }
          statusEl.textContent = stMsg('workspaceAgentSaved');
        } catch (_) {
          statusEl.textContent = stMsg('workspaceAgentSaveError');
        }
      }

      window.refreshAgentServerDefaultsHint = function (cfg) {
        if (!hintEl || !cfg) return;
        hintEl.style.display = cfg.agentDefaultSystemSet ? 'block' : 'none';
      };
      window.loadWorkspaceAgentSettingsPanel = loadPanel;

      if (loadBtn) loadBtn.onclick = function () { loadPanel(); };
      if (saveBtn) saveBtn.onclick = function () { savePanel(); };
      if (settingsToggle) {
        settingsToggle.addEventListener('toggle', function () {
          if (settingsToggle.open) loadPanel();
        });
      }
      if (workspaceSelect) {
        workspaceSelect.addEventListener('change', function () {
          if (settingsToggle && settingsToggle.open) loadPanel();
        });
      }
    })();

    // Phase 29: Team workspaces - create, join, invite, members, activity
    (function initPhase29Workspace() {
      document.getElementById('workspace-details');
      const wsCreateBtn = document.getElementById('workspace-create-btn');
      const wsJoinBtn = document.getElementById('workspace-join-btn');
      const wsInviteBtn = document.getElementById('workspace-invite-btn');
      const wsCreateModal = document.getElementById('workspace-create-modal');
      const wsJoinModal = document.getElementById('workspace-join-modal');
      const wsCreateName = document.getElementById('workspace-create-name');
      const wsCreateType = document.getElementById('workspace-create-type');
      const wsCreateSubmit = document.getElementById('workspace-create-submit');
      const wsCreateCancel = document.getElementById('workspace-create-cancel');
      const wsJoinCode = document.getElementById('workspace-join-code');
      const wsJoinSubmit = document.getElementById('workspace-join-submit');
      const wsJoinCancel = document.getElementById('workspace-join-cancel');
      const wsJoinStatus = document.getElementById('workspace-join-status');
      const wsTeamPanel = document.getElementById('workspace-team-panel');
      const wsMembersList = document.getElementById('workspace-members-list');
      const wsActivityList = document.getElementById('workspace-activity-list');

      function showModal(el) { if (el) { el.style.display = 'flex'; } }
      function hideModal(el) { if (el) { el.style.display = 'none'; } }

      function updateTeamPanelVisibility() {
        if (!wsTeamPanel || !workspaceSelect) return;
        const wsId = workspaceSelect.value;
        const opt = workspaceSelect.querySelector('option[value="' + wsId + '"]');
        const isTeam = opt && opt.dataset?.type === 'team';
        wsTeamPanel.style.display = isTeam ? '' : 'none';
        if (isTeam && wsId && wsId !== 'default') {
          loadWorkspaceMembers(wsId);
          loadWorkspaceActivity(wsId);
        }
      }

      async function loadWorkspaceMembers(wsId) {
        if (!wsMembersList) return;
        try {
          const res = await fetch('/api/workspaces/' + encodeURIComponent(wsId) + '/members', getStorageFetchOptions());
          if (res.ok) {
            const data = await res.json();
            wsMembersList.innerHTML = (data.members || []).map(m => '<li>' + escapeHtml(m.userId) + ' <span style="color:#64748b;">(' + (m.role || 'member') + ')</span></li>').join('') || '<li class="panel-hint">No members</li>';
          }
        } catch (_) { wsMembersList.innerHTML = '<li class="panel-hint">Failed to load</li>'; }
      }

      async function loadWorkspaceActivity(wsId) {
        if (!wsActivityList) return;
        try {
          const res = await fetch('/api/workspaces/' + encodeURIComponent(wsId) + '/activity', getStorageFetchOptions());
          if (res.ok) {
            const data = await res.json();
            wsActivityList.innerHTML = (data.items || []).map(a => '<li>' + escapeHtml(a.userId) + ': ' + escapeHtml(a.action || '') + (a.title ? ' (' + escapeHtml(a.title) + ')' : '') + ' <span style="color:#64748b;font-size:0.75rem;">' + (a.timestamp ? new Date(a.timestamp).toLocaleString() : '') + '</span></li>').join('') || '<li class="panel-hint">No activity</li>';
          }
        } catch (_) { wsActivityList.innerHTML = '<li class="panel-hint">Failed to load</li>'; }
      }

      if (workspaceSelect) {
        workspaceSelect.addEventListener('change', () => {
          setWorkspace(workspaceSelect.value);
          updateTeamPanelVisibility();
        });
      }

      if (wsCreateBtn && wsCreateModal) {
        wsCreateBtn.onclick = () => { wsCreateName.value = ''; wsCreateType.value = 'personal'; showModal(wsCreateModal); };
      }
      if (wsCreateSubmit && wsCreateModal && wsCreateName) {
        wsCreateSubmit.onclick = async () => {
          const name = wsCreateName.value?.trim() || 'Workspace';
          const type = wsCreateType.value === 'team' ? 'team' : 'personal';
          try {
            const res = await fetch('/api/workspaces', { method: 'POST', ...getStorageFetchOptions(), body: JSON.stringify({ name, type }) });
            if (res.ok) {
              const ws = await res.json();
              hideModal(wsCreateModal);
              loadWorkspaces();
              setWorkspace(ws.id);
              if (workspaceSelect) workspaceSelect.value = ws.id;
              updateTeamPanelVisibility();
            } else {
              const err = await res.json().catch(() => ({}));
              alert(err.error || 'Failed to create');
            }
          } catch (e) { alert('Failed to create workspace'); }
        };
      }
      if (wsCreateCancel && wsCreateModal) wsCreateCancel.onclick = () => hideModal(wsCreateModal);

      if (wsJoinBtn && wsJoinModal) {
        wsJoinBtn.onclick = () => {
          const join = new URLSearchParams(window.location.search).get('join');
          if (join) wsJoinCode.value = join;
          if (wsJoinStatus) wsJoinStatus.textContent = '';
          showModal(wsJoinModal);
        };
      }
      if (wsJoinSubmit && wsJoinModal && wsJoinCode) {
        wsJoinSubmit.onclick = async () => {
          const code = wsJoinCode.value?.trim();
          if (!code) { if (wsJoinStatus) wsJoinStatus.textContent = 'Enter invite code'; return; }
          if (wsJoinStatus) wsJoinStatus.textContent = 'Joining…';
          try {
            const res = await fetch('/api/workspaces/join', { method: 'POST', ...getStorageFetchOptions(), body: JSON.stringify({ code }) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
              hideModal(wsJoinModal);
              wsJoinCode.value = '';
              if (wsJoinStatus) wsJoinStatus.textContent = '';
              loadWorkspaces();
              if (data.workspace?.id) { setWorkspace(data.workspace.id); if (workspaceSelect) workspaceSelect.value = data.workspace.id; }
              updateTeamPanelVisibility();
              window.history.replaceState({}, '', window.location.pathname);
            } else {
              if (wsJoinStatus) wsJoinStatus.textContent = data.error || 'Join failed';
            }
          } catch (e) { if (wsJoinStatus) wsJoinStatus.textContent = 'Join failed'; }
        };
      }
      if (wsJoinCancel && wsJoinModal) wsJoinCancel.onclick = () => hideModal(wsJoinModal);

      if (wsInviteBtn && workspaceSelect) {
        wsInviteBtn.onclick = async () => {
          const wsId = workspaceSelect.value;
          if (!wsId || wsId === 'default') { alert('Select a team workspace first'); return; }
          try {
            const res = await fetch('/api/workspaces/' + encodeURIComponent(wsId) + '/invite', { method: 'POST', ...getStorageFetchOptions(), body: JSON.stringify({}) });
            if (res.ok) {
              const data = await res.json();
              const link = data.inviteLink || (window.location.origin + '/?join=' + data.code);
              await navigator.clipboard.writeText(link).catch(() => {});
              alert('Invite link copied to clipboard: ' + (data.code || ''));
            } else {
              const err = await res.json().catch(() => ({}));
              alert(err.error || 'Failed to generate invite');
            }
          } catch (e) { alert('Failed to generate invite'); }
        };
      }

      const joinParam = new URLSearchParams(window.location.search).get('join');
      if (joinParam && config.authRequired && wsJoinModal && wsJoinCode) {
        wsJoinCode.value = joinParam;
        showModal(wsJoinModal);
      }
      updateTeamPanelVisibility();
    })();

    // Phase 31: Locale switcher (Settings)
    const localeSelect = document.getElementById('locale-select');
    if (localeSelect && window.SiskelI18n) {
      localeSelect.addEventListener('change', () => {
        const lang = localeSelect.value;
        if (lang) SiskelI18n.setLocale(lang);
      });
    }

    // Phase 9: Allow recipe step execution toggle (Settings) — Phase 100: confirm before enabling
    const allowRecipeExecutionCheckbox = document.getElementById('allow-recipe-execution');
    if (allowRecipeExecutionCheckbox) {
      try {
        allowRecipeExecutionCheckbox.checked = localStorage.getItem(RECIPE_EXECUTION_STORAGE_KEY) === '1';
      } catch (_) {}
      allowRecipeExecutionCheckbox.addEventListener('change', () => {
        if (allowRecipeExecutionCheckbox.checked) {
          const serverAllows = config && config.allowRecipeStepExecution;
          let ok = true;
          try {
            const seen = sessionStorage.getItem(EXECUTION_ENABLE_CONFIRMED_KEY) === '1';
            if (!seen) {
              ok = window.confirm(
                serverAllows
                  ? 'Recipe step execution can run build/deploy actions on the server when the model calls execute_step. Only enable if you trust this workspace and model. Continue?'
                  : 'You enabled client-side execution permission, but this host may still block runs until ALLOW_RECIPE_STEP_EXECUTION=1. Continue saving this preference?'
              );
              if (ok) sessionStorage.setItem(EXECUTION_ENABLE_CONFIRMED_KEY, '1');
            }
          } catch (_) {}
          if (!ok) {
            allowRecipeExecutionCheckbox.checked = false;
            return;
          }
        }
        try {
          localStorage.setItem(RECIPE_EXECUTION_STORAGE_KEY, allowRecipeExecutionCheckbox.checked ? '1' : '0');
        } catch (_) {}
      });
    }

    const agentMaxIterationsInput = document.getElementById('agent-max-iterations');
    if (agentMaxIterationsInput) {
      try {
        const v = localStorage.getItem(AGENT_MAX_ITER_CLIENT_KEY);
        if (v) agentMaxIterationsInput.value = v;
      } catch (_) {}
      agentMaxIterationsInput.addEventListener('change', () => {
        try {
          const n = agentMaxIterationsInput.value.trim();
          if (n) localStorage.setItem(AGENT_MAX_ITER_CLIENT_KEY, n);
          else localStorage.removeItem(AGENT_MAX_ITER_CLIENT_KEY);
        } catch (_) {}
      });
    }

    function loadAgentPresets() {
      try {
        const raw = localStorage.getItem(AGENT_PRESETS_STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (_) {
        return [];
      }
    }

    function saveAgentPresets(list) {
      try {
        localStorage.setItem(AGENT_PRESETS_STORAGE_KEY, JSON.stringify(list.slice(0, 24)));
      } catch (_) {}
    }

    function refreshAgentPresetSelect() {
      const sel = document.getElementById('agent-preset-select');
      if (!sel) return;
      const presets = loadAgentPresets();
      sel.innerHTML = '<option value="">— Load preset —</option>';
      presets.forEach((p, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = p.name || `Preset ${i + 1}`;
        sel.appendChild(o);
      });
    }

    refreshAgentPresetSelect();

    document.getElementById('agent-preset-apply')?.addEventListener('click', () => {
      const sel = document.getElementById('agent-preset-select');
      const idx = sel && sel.value !== '' ? Number(sel.value) : NaN;
      const presets = loadAgentPresets();
      const p = presets[idx];
      if (!p) {
        showNotice('Select a preset first', 'warning', false);
        return;
      }
      if (agentModeCheckbox) agentModeCheckbox.checked = !!p.agentMode;
      if (swarmModeCheckbox) swarmModeCheckbox.checked = !!p.swarmMode;
      if (swarmParallelAgentsCheckbox) swarmParallelAgentsCheckbox.checked = !!p.parallelAgents;
      if (allowRecipeExecutionCheckbox) allowRecipeExecutionCheckbox.checked = !!p.allowExecution;
      if (agentMaxIterationsInput && p.maxIterations != null) agentMaxIterationsInput.value = String(p.maxIterations);
      else if (agentMaxIterationsInput && p.maxIterations === null) agentMaxIterationsInput.value = '';
      try {
        localStorage.setItem(AGENT_MODE_STORAGE_KEY, agentModeCheckbox?.checked ? '1' : '0');
        localStorage.setItem(SWARM_MODE_STORAGE_KEY, swarmModeCheckbox?.checked ? '1' : '0');
        localStorage.setItem(SWARM_PARALLEL_STORAGE_KEY, swarmParallelAgentsCheckbox?.checked ? '1' : '0');
        localStorage.setItem(RECIPE_EXECUTION_STORAGE_KEY, allowRecipeExecutionCheckbox?.checked ? '1' : '0');
        if (p.maxIterations != null) localStorage.setItem(AGENT_MAX_ITER_CLIENT_KEY, String(p.maxIterations));
        else localStorage.removeItem(AGENT_MAX_ITER_CLIENT_KEY);
      } catch (_) {}
      syncInteractionModeFromCheckboxes();
      showNotice('Preset applied', 'warning', false);
      setTimeout(clearNotice, 1500);
    });

    document.getElementById('agent-preset-save')?.addEventListener('click', () => {
      const name = window.prompt('Preset name', 'My agent setup');
      if (name == null || !String(name).trim()) return;
      let maxIt = null;
      if (agentMaxIterationsInput && agentMaxIterationsInput.value.trim()) {
        const n = parseInt(agentMaxIterationsInput.value, 10);
        if (n >= 1) maxIt = n;
      }
      const entry = {
        name: String(name).trim(),
        agentMode: !!(agentModeCheckbox && agentModeCheckbox.checked),
        swarmMode: !!(swarmModeCheckbox && swarmModeCheckbox.checked),
        parallelAgents: !!(swarmParallelAgentsCheckbox && swarmParallelAgentsCheckbox.checked),
        allowExecution: !!(allowRecipeExecutionCheckbox && allowRecipeExecutionCheckbox.checked),
        maxIterations: maxIt,
      };
      const presets = loadAgentPresets();
      presets.push(entry);
      saveAgentPresets(presets);
      refreshAgentPresetSelect();
      const sel = document.getElementById('agent-preset-select');
      if (sel) sel.value = String(presets.length - 1);
      showNotice('Preset saved', 'warning', false);
      setTimeout(clearNotice, 1500);
    });

    // Phase 15: Agent mode toggle (Settings)
    const agentModeCheckbox = document.getElementById('agent-mode');
    if (agentModeCheckbox) {
      try {
        agentModeCheckbox.checked = localStorage.getItem(AGENT_MODE_STORAGE_KEY) === '1';
      } catch (_) {}
      agentModeCheckbox.addEventListener('change', () => {
        try {
          localStorage.setItem(AGENT_MODE_STORAGE_KEY, agentModeCheckbox.checked ? '1' : '0');
        } catch (_) {}
        syncInteractionModeFromCheckboxes();
      });
    }

    // Swarm mode toggle (Settings) - shown when config.swarmEnabled
    const swarmModeCheckbox = document.getElementById('swarm-mode');
    const swarmParallelAgentsCheckbox = document.getElementById('swarm-parallel-agents');
    const swarmModeSection = document.getElementById('swarm-mode-section');
    const swarmLlmRosterPanel = document.getElementById('swarm-llm-roster-panel');
    const swarmLlmRosterSpecialistsEl = document.getElementById('swarm-llm-roster-specialists');
    if (swarmModeCheckbox) {
      try {
        swarmModeCheckbox.checked = localStorage.getItem(SWARM_MODE_STORAGE_KEY) === '1';
      } catch (_) {}
      swarmModeCheckbox.addEventListener('change', () => {
        try {
          localStorage.setItem(SWARM_MODE_STORAGE_KEY, swarmModeCheckbox.checked ? '1' : '0');
        } catch (_) {}
        syncInteractionModeFromCheckboxes();
      });
    }
    if (swarmParallelAgentsCheckbox) {
      try {
        const storedParallel = localStorage.getItem(SWARM_PARALLEL_STORAGE_KEY);
        swarmParallelAgentsCheckbox.checked =
          storedParallel !== null ? storedParallel === '1' : !!config.swarmParallelAgentsDefault;
      } catch (_) {}
      swarmParallelAgentsCheckbox.addEventListener('change', () => {
        try {
          localStorage.setItem(SWARM_PARALLEL_STORAGE_KEY, swarmParallelAgentsCheckbox.checked ? '1' : '0');
        } catch (_) {}
      });
    }

    function persistSwarmLlmRosterSelection() {
      if (!swarmLlmRosterSpecialistsEl) return;
      const sel = [...swarmLlmRosterSpecialistsEl.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
      try {
        localStorage.setItem(SWARM_ROSTER_STORAGE_KEY, JSON.stringify(sel));
      } catch (_) {}
    }

    function populateSwarmLlmRosterSpecialists() {
      if (!swarmLlmRosterSpecialistsEl || !config) return;
      const names =
        Array.isArray(config.swarmSelectableSpecialists) && config.swarmSelectableSpecialists.length
          ? config.swarmSelectableSpecialists.slice()
          : ['researcher', 'executor'];
      let saved = [];
      try {
        const raw = localStorage.getItem(SWARM_ROSTER_STORAGE_KEY);
        if (raw) saved = JSON.parse(raw).filter((n) => typeof n === 'string' && names.includes(n));
      } catch (_) {}
      const defaultSet = new Set();
      if (saved.length === 0) {
        if (names.includes('researcher')) defaultSet.add('researcher');
        if (names.includes('executor')) defaultSet.add('executor');
        if (defaultSet.size === 0) names.slice(0, 2).forEach((n) => defaultSet.add(n));
        if (defaultSet.size === 0 && names[0]) defaultSet.add(names[0]);
      }
      swarmLlmRosterSpecialistsEl.innerHTML = names
        .map((n) => {
          const checked = saved.length > 0 ? saved.includes(n) : defaultSet.has(n);
          const id = 'swarm-llm-roster-' + String(n).replace(/[^a-z0-9_-]/gi, '-');
          return (
            '<label for="' +
            id +
            '"><input type="checkbox" id="' +
            id +
            '" value="' +
            escapeHtml(n) +
            '" ' +
            (checked ? 'checked ' : '') +
            '> ' +
            escapeHtml(n) +
            '</label>'
          );
        })
        .join('');
      swarmLlmRosterSpecialistsEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', persistSwarmLlmRosterSelection);
      });
    }

    function getSelectedSwarmLlmSpecialists() {
      if (!config || !config.swarmClientSpecialistsAllowed || !swarmLlmRosterSpecialistsEl) return null;
      const sel = [...swarmLlmRosterSpecialistsEl.querySelectorAll('input[type="checkbox"]:checked')]
        .map((c) => c.value.trim())
        .filter(Boolean);
      if (sel.length) return sel;
      const fb =
        Array.isArray(config.swarmSelectableSpecialists) && config.swarmSelectableSpecialists[0]
          ? [config.swarmSelectableSpecialists[0]]
          : ['researcher'];
      return fb;
    }

    function updateSwarmSectionVisibility() {
      if (swarmModeSection) swarmModeSection.style.display = config.swarmEnabled ? '' : 'none';
      if (swarmLlmRosterPanel) {
        swarmLlmRosterPanel.style.display =
          config.swarmEnabled && config.swarmClientSpecialistsAllowed ? '' : 'none';
      }
    }

    const INTERACTION_MODE_STORAGE_KEY = 'siskelbot-interaction-mode';
    const TOOL_SWARM_SPECS_STORAGE_KEY = 'siskelbot-tool-swarm-specialists';
    const TOOL_SWARM_ALLOW_EXEC_KEY = 'siskelbot-tool-swarm-allow-exec';
    let suppressInteractionSync = false;
    let currentInteractionMode = 'chat';
    const interactionModeBadge = document.getElementById('interaction-mode-badge');
    const toolSwarmPanel = document.getElementById('tool-swarm-panel');
    const toolSwarmSpecialistsEl = document.getElementById('tool-swarm-specialists');
    const toolSwarmAllowExec = document.getElementById('tool-swarm-allow-exec');

    function modeBadgeLabel(mode) {
      if (mode === 'agent') return 'Agent';
      if (mode === 'swarm') return 'Multi-agent';
      if (mode === 'tool-swarm') return 'Tool swarm';
      return 'Chat';
    }

    function updateInteractionModeBadge() {
      if (interactionModeBadge) {
        interactionModeBadge.textContent = modeBadgeLabel(currentInteractionMode);
        interactionModeBadge.title = 'How the next send runs: ' + modeBadgeLabel(currentInteractionMode);
      }
    }

    function getLegacySpecialistNames() {
      const names = config.legacySwarmSpecialists;
      return Array.isArray(names) && names.length ? names.slice() : ['researcher', 'executor'];
    }

    function persistToolSwarmSpecialists() {
      if (!toolSwarmSpecialistsEl) return;
      const sel = [...toolSwarmSpecialistsEl.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
      try {
        localStorage.setItem(TOOL_SWARM_SPECS_STORAGE_KEY, JSON.stringify(sel));
      } catch (_) {}
    }

    function populateToolSwarmSpecialists() {
      if (!toolSwarmSpecialistsEl) return;
      const names = getLegacySpecialistNames();
      let saved = [];
      try {
        const raw = localStorage.getItem(TOOL_SWARM_SPECS_STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
      } catch (_) {}
      toolSwarmSpecialistsEl.innerHTML = names.map((n) => {
        const checked = saved.length === 0 ? true : saved.indexOf(n) >= 0;
        const id = 'tool-swarm-spec-' + n.replace(/[^a-z0-9_-]/gi, '-');
        return '<label for="' + id + '"><input type="checkbox" id="' + id + '" value="' + escapeHtml(n) + '" ' + (checked ? 'checked ' : '') + '> ' + escapeHtml(n) + '</label>';
      }).join('');
      toolSwarmSpecialistsEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', persistToolSwarmSpecialists);
      });
    }

    function getSelectedToolSwarmSpecialists() {
      if (!toolSwarmSpecialistsEl) return getLegacySpecialistNames();
      const sel = [...toolSwarmSpecialistsEl.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value.trim()).filter(Boolean);
      return sel.length ? sel : getLegacySpecialistNames();
    }

    function applyInteractionMode(mode) {
      let m = mode;
      if (m === 'swarm' && !config.swarmEnabled) m = 'agent';
      currentInteractionMode = m;
      document.querySelectorAll('.mode-chip[data-interaction-mode]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.interactionMode === m ? 'true' : 'false');
      });
      if (toolSwarmPanel) {
        const show = m === 'tool-swarm';
        toolSwarmPanel.style.display = show ? '' : 'none';
        if (show) toolSwarmPanel.open = true;
      }
      const swarmChip = document.getElementById('mode-chip-swarm');
      if (swarmChip) {
        swarmChip.disabled = !config.swarmEnabled;
        swarmChip.title = config.swarmEnabled
          ? 'Streaming multi-agent (ENABLE_AGENT_SWARM)'
          : 'Disabled on server — set ENABLE_AGENT_SWARM=1';
      }
      suppressInteractionSync = true;
      if (m !== 'tool-swarm') {
        const agentOn = m === 'agent' || m === 'swarm';
        const swarmOn = m === 'swarm' && config.swarmEnabled;
        if (agentModeCheckbox) agentModeCheckbox.checked = agentOn;
        if (swarmModeCheckbox) swarmModeCheckbox.checked = swarmOn;
        try {
          localStorage.setItem(AGENT_MODE_STORAGE_KEY, agentOn ? '1' : '0');
          localStorage.setItem(SWARM_MODE_STORAGE_KEY, swarmOn ? '1' : '0');
        } catch (_) {}
      }
      suppressInteractionSync = false;
      try {
        localStorage.setItem(INTERACTION_MODE_STORAGE_KEY, m);
      } catch (_) {}
      updateInteractionModeBadge();
    }

    function syncInteractionModeFromCheckboxes() {
      if (suppressInteractionSync) return;
      if (currentInteractionMode === 'tool-swarm') return;
      const ag = agentModeCheckbox?.checked;
      const sw = swarmModeCheckbox?.checked;
      let mode = 'chat';
      if (ag && sw && config.swarmEnabled) mode = 'swarm';
      else if (ag) mode = 'agent';
      currentInteractionMode = mode;
      document.querySelectorAll('.mode-chip[data-interaction-mode]').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.interactionMode === mode ? 'true' : 'false');
      });
      updateInteractionModeBadge();
      try {
        localStorage.setItem(INTERACTION_MODE_STORAGE_KEY, mode);
      } catch (_) {}
    }

    function initInteractionModes() {
      populateToolSwarmSpecialists();
      populateSwarmLlmRosterSpecialists();
      let stored = null;
      try {
        stored = localStorage.getItem(INTERACTION_MODE_STORAGE_KEY);
      } catch (_) {}
      if (stored === 'tool-swarm') {
        applyInteractionMode('tool-swarm');
      } else if (stored === 'swarm' || stored === 'agent' || stored === 'chat') {
        if (stored === 'swarm' && !config.swarmEnabled) applyInteractionMode('agent');
        else applyInteractionMode(stored);
      } else {
        const ag = agentModeCheckbox?.checked;
        const sw = swarmModeCheckbox?.checked;
        const derived = ag && sw && config.swarmEnabled ? 'swarm' : ag ? 'agent' : 'chat';
        applyInteractionMode(derived);
      }
      if (toolSwarmAllowExec) {
        try {
          toolSwarmAllowExec.checked = localStorage.getItem(TOOL_SWARM_ALLOW_EXEC_KEY) === '1';
        } catch (_) {}
        if (!toolSwarmAllowExec.dataset.wired) {
          toolSwarmAllowExec.dataset.wired = '1';
          toolSwarmAllowExec.addEventListener('change', () => {
            try {
              localStorage.setItem(TOOL_SWARM_ALLOW_EXEC_KEY, toolSwarmAllowExec.checked ? '1' : '0');
            } catch (_) {}
          });
        }
      }
      document.querySelectorAll('.mode-chip[data-interaction-mode]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          const mode = btn.dataset.interactionMode;
          if (mode === 'swarm' && !config.swarmEnabled) return;
          applyInteractionMode(mode);
        });
      });
    }

    // Phase 24: Backup & Restore (Settings)
    const backupCreateBtn = document.getElementById('backup-create-btn');
    const backupRefreshBtn = document.getElementById('backup-refresh-btn');
    const backupListEl = document.getElementById('backup-list');
    const backupStatusEl = document.getElementById('backup-status');
    async function setBackupStatus(msg, isError) {
      if (backupStatusEl) { backupStatusEl.textContent = msg || ''; backupStatusEl.style.color = isError ? '#f87171' : '#94a3b8'; }
    }
    async function loadBackupList() {
      if (!backupListEl) return;
      setBackupStatus('Loading…');
      try {
        const res = await fetch('/api/backup', getStorageFetchOptions());
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setBackupStatus(err.error || 'Failed to list backups', true);
          backupListEl.innerHTML = '';
          return;
        }
        const data = await res.json();
        const items = data.items || [];
        if (items.length === 0) {
          backupListEl.innerHTML = '<p style="color:#64748b;margin:0;padding:0.35rem 0;">No backups yet.</p>';
          setBackupStatus('');
        } else {
          backupListEl.innerHTML = items.map(b => {
            const size = b.sizeBytes != null ? ` (${(b.sizeBytes / 1024).toFixed(1)} KB)` : '';
            return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid #334155;"><span style="flex:1;">${escapeHtml(b.id)}${size}</span><button type="button" class="header-button" data-backup-id="${escapeHtml(b.id)}" style="flex-shrink:0;">Restore</button></div>`;
          }).join('');
          backupListEl.querySelectorAll('[data-backup-id]').forEach(btn => {
            btn.addEventListener('click', () => restoreBackup(btn.getAttribute('data-backup-id')));
          });
          setBackupStatus('');
        }
      } catch (e) {
        setBackupStatus('Failed to list backups', true);
        backupListEl.innerHTML = '';
      }
    }
    async function restoreBackup(id) {
      if (!id || !confirm('Restore backup "' + id + '"? This will replace all current data.')) return;
      setBackupStatus('Restoring…');
      try {
        const res = await fetch(`/api/backup/restore/${encodeURIComponent(id)}`, { method: 'POST', ...getStorageFetchOptions() });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setBackupStatus(err.error || 'Restore failed', true);
          return;
        }
        setBackupStatus('Restored. Reload to see changes.');
        loadBackupList();
      } catch (e) {
        setBackupStatus('Restore failed', true);
      }
    }
    if (backupCreateBtn) backupCreateBtn.addEventListener('click', async () => {
      setBackupStatus('Creating backup…');
      try {
        const res = await fetch('/api/backup', { method: 'POST', ...getStorageFetchOptions() });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setBackupStatus(err.error || 'Create failed', true);
          return;
        }
        setBackupStatus('Backup created');
        loadBackupList();
      } catch (e) {
        setBackupStatus('Create failed', true);
      }
    });
    if (backupRefreshBtn) backupRefreshBtn.addEventListener('click', loadBackupList);

    const HEALTH_REFRESH_MS = 30000;

    async function loadHealth(forceRefresh) {
      const backendEl = document.getElementById('health-backend');
      const reachableEl = document.getElementById('health-reachable');
      const latencyEl = document.getElementById('health-latency');
      const lastCheckEl = document.getElementById('health-last-check');
      const backendsEl = document.getElementById('health-backends');
      if (!backendEl) return;
      try {
        const url = forceRefresh ? '/health?refresh=1' : '/health';
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        backendEl.textContent = data.backend ?? '—';
        reachableEl.textContent = data.reachable === true ? 'Yes' : data.reachable === false ? 'No' : '—';
        latencyEl.textContent = data.latencyMs != null ? data.latencyMs + ' ms' : '—';
        lastCheckEl.textContent = data.lastChecked ? new Date(data.lastChecked).toLocaleTimeString() : (data.cached ? '(cached)' : '—');
        if (data.backends && backendsEl) {
          backendsEl.innerHTML = Object.entries(data.backends).map(([name, s]) => {
            const cls = s.reachable ? 'reachable' : 'unreachable';
            const lat = s.latencyMs != null ? s.latencyMs + ' ms' : '';
            return `<div class="backend-item ${cls}">${name}: ${s.reachable ? 'OK' : 'down'}${lat ? ' (' + lat + ')' : ''}</div>`;
          }).join('');
        }
      } catch (_) {
        backendEl.textContent = '—';
        reachableEl.textContent = 'Error';
        latencyEl.textContent = '—';
        lastCheckEl.textContent = new Date().toLocaleTimeString();
        if (backendsEl) backendsEl.innerHTML = '';
      }
    }
    loadHealth();
    setInterval(loadHealth, HEALTH_REFRESH_MS);

    const healthRefreshBtn = document.getElementById('health-refresh-btn');
    if (healthRefreshBtn) healthRefreshBtn.addEventListener('click', () => loadHealth(true));

    // --- Phase 4: Integrations panel ---
    const integrationsToggle = document.getElementById('integrations-toggle');
    const githubStatusEl = document.getElementById('github-status');
    const vercelStatusEl = document.getElementById('vercel-status');
    const refreshReposBtn = document.getElementById('refresh-repos-btn');
    const refreshDeploymentsBtn = document.getElementById('refresh-deployments-btn');
    const integrationsList = document.getElementById('integrations-list');
    const integrationsHint = document.getElementById('integrations-hint');

    function setIntegrationsHint(message) {
      if (integrationsHint) integrationsHint.textContent = message;
    }

    async function loadIntegrationsStatus() {
      if (!githubStatusEl || !vercelStatusEl) return;
      try {
        const res = await fetch('/api/integrations/status');
        if (!res.ok) {
          setIntegrationsHint('Could not load integration status. Check the server logs and integration environment variables.');
          return;
        }
        const data = await res.json();
        githubStatusEl.textContent = 'GitHub: ' + (data.github ? 'connected' : 'missing');
        githubStatusEl.className = data.github ? 'connected' : 'missing';
        vercelStatusEl.textContent = 'Vercel: ' + (data.vercel ? 'connected' : 'missing');
        vercelStatusEl.className = data.vercel ? 'connected' : 'missing';
        if (refreshReposBtn) refreshReposBtn.disabled = !data.github;
        if (refreshDeploymentsBtn) refreshDeploymentsBtn.disabled = !data.vercel;
        if (data.github && data.vercel) {
          setIntegrationsHint('GitHub and Vercel are connected. Use recipes with deploy steps to turn changes into deployments.');
        } else {
          const missing = [];
          if (!data.github) missing.push('GITHUB_TOKEN');
          if (!data.vercel) missing.push('VERCEL_TOKEN');
          setIntegrationsHint('Missing server-side ' + missing.join(' and ') + '. Set tokens to unlock repos, deployments, and deploy recipes.');
        }
      } catch (err) {
        setIntegrationsHint('Could not load integration status: ' + (err.message || 'request failed'));
      }
    }

    async function refreshRepos() {
      if (!integrationsList) return;
      integrationsList.innerHTML = '<li>Loading...</li>';
      integrationsList.classList.remove('empty');
      try {
        const res = await fetch('/api/github/repos');
        const data = await res.json();
        if (!res.ok) {
          integrationsList.innerHTML = '<li class="integrations-list empty">' + (data.hint || data.error || 'Error') + '</li>';
          return;
        }
        const repos = Array.isArray(data) ? data : [];
        if (repos.length === 0) {
          integrationsList.innerHTML = '<li class="integrations-list empty">No repos found. Confirm GITHUB_TOKEN has access to the repositories you expect.</li>';
          return;
        }
        integrationsList.innerHTML = repos.slice(0, 50).map(r => {
          const name = r.full_name || r.name || r.id || '?';
          const url = r.html_url ? ` target="_blank" rel="noopener" href="${r.html_url}"` : '';
          return '<li' + (url ? '><a' + url + '>' : '>') + escapeHtml(name) + (url ? '</a></li>' : '</li>');
        }).join('');
        integrationsList.classList.remove('empty');
      } catch (err) {
        integrationsList.innerHTML = '<li class="integrations-list empty">' + escapeHtml(err.message || 'Failed to fetch') + '</li>';
      }
    }

    async function refreshDeployments() {
      if (!integrationsList) return;
      integrationsList.innerHTML = '<li>Loading...</li>';
      integrationsList.classList.remove('empty');
      try {
        const res = await fetch('/api/vercel/deployments');
        const data = await res.json();
        if (!res.ok) {
          integrationsList.innerHTML = '<li class="integrations-list empty">' + (data.hint || data.error || 'Error') + '</li>';
          return;
        }
        const deployments = data.deployments || (Array.isArray(data) ? data : []);
        if (deployments.length === 0) {
          integrationsList.innerHTML = '<li class="integrations-list empty">No deployments found. Confirm VERCEL_TOKEN can access the target Vercel team and project.</li>';
          return;
        }
        integrationsList.innerHTML = deployments.slice(0, 50).map(d => {
          const name = d.name || d.url || d.uid || '?';
          const state = d.state ? ` (${d.state})` : '';
          const url = d.url ? ` target="_blank" rel="noopener" href="https://${d.url}"` : '';
          return '<li' + (url ? '><a' + url + '>' : '>') + escapeHtml(String(name) + state) + (url ? '</a></li>' : '</li>');
        }).join('');
        integrationsList.classList.remove('empty');
      } catch (err) {
        integrationsList.innerHTML = '<li class="integrations-list empty">' + escapeHtml(err.message || 'Failed to fetch') + '</li>';
      }
    }

    loadIntegrationsStatus();
    if (integrationsToggle) {
      integrationsToggle.addEventListener('toggle', () => {
        if (integrationsToggle.open) loadIntegrationsStatus();
      });
    }
    if (refreshReposBtn) refreshReposBtn.onclick = refreshRepos;
    if (refreshDeploymentsBtn) refreshDeploymentsBtn.onclick = refreshDeployments;

    // --- Phase 13 + 18: Usage panel with analytics ---
    const usageToggle = document.getElementById('usage-toggle');
    const usageStatusEl = document.getElementById('usage-status');
    const usageRefreshBtn = document.getElementById('usage-refresh-btn');
    const usageDaysSelect = document.getElementById('usage-days');
    const usageAnalyticsEl = document.getElementById('usage-analytics');
    const usageCostEl = document.getElementById('usage-cost');
    const usageByModelList = document.getElementById('usage-by-model-list');
    const usageModelComparisonEl = document.getElementById('usage-model-comparison');
    const usageExportCsv = document.getElementById('usage-export-csv');
    const usageExportJson = document.getElementById('usage-export-json');

    async function loadUsageStatus() {
      if (!usageStatusEl) return;
      usageStatusEl.textContent = 'Loading…';
      if (usageAnalyticsEl) usageAnalyticsEl.style.display = 'none';
      const days = usageDaysSelect ? Math.min(90, Math.max(1, parseInt(usageDaysSelect.value, 10) || 7)) : 7;
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : null;
      const headers = typeof getStorageHeaders === 'function' ? getStorageHeaders() : {};
      const wsParam = workspace && workspace !== 'default' ? '&workspace=' + encodeURIComponent(workspace) : '';
      try {
        const res = await fetch('/api/analytics/dashboard?days=' + days + wsParam, { headers });
        if (!res.ok) {
          const summaryUrl = '/api/usage/summary?days=' + days + (workspace && workspace !== 'default' ? '&workspace=' + encodeURIComponent(workspace) : '');
          const summaryRes = await fetch(summaryUrl);
          if (!summaryRes.ok) {
            usageStatusEl.textContent = 'Error loading usage';
            return;
          }
          const data = await summaryRes.json();
          const req = data.totalRequests ?? 0;
          const total = ((data.totalInputTokens ?? 0) + (data.totalOutputTokens ?? 0)) || (data.totalTokens ?? 0);
          let html = '<strong>' + req + '</strong> requests · ~<strong>' + (total).toLocaleString() + '</strong> tokens (last ' + days + ' days)';
          if (data.quota != null && data.quota.remaining != null) {
            html += ' · Quota: <strong>' + (data.quota.remaining).toLocaleString() + '</strong> / ' + (data.quota.limit).toLocaleString() + ' remaining';
          }
          usageStatusEl.innerHTML = html;
          return;
        }
        const data = await res.json();
        const req = data.totalRequests ?? 0;
        const total = data.totalTokens ?? (data.totalInputTokens ?? 0) + (data.totalOutputTokens ?? 0);
        let html = '<strong>' + req + '</strong> requests · ~<strong>' + (total).toLocaleString() + '</strong> tokens (last ' + days + ' days)';
        if (data.quota != null && data.quota.remaining != null) {
          html += ' · Quota: <strong>' + (data.quota.remaining).toLocaleString() + '</strong> / ' + (data.quota.limit).toLocaleString() + ' remaining';
        }
        usageStatusEl.innerHTML = html;
        if (usageCostEl) {
          const cost = data.totalCost ?? 0;
          const src = data.costSource || 'local';
          usageCostEl.textContent = src === 'local' ? 'Cost: local (Ollama/vLLM)' : 'Est. cost: $' + cost.toFixed(4);
        }
        if (usageByModelList && data.byModel) {
          usageByModelList.innerHTML = Object.entries(data.byModel).map(function (e) {
            const m = e[0];
            const v = e[1];
            const tok = (v.inputTokens || 0) + (v.outputTokens || 0);
            const costStr = v.source === 'local' ? '' : ' · $' + (v.cost || 0).toFixed(4);
            return '<li><strong>' + escapeHtml(m) + '</strong>: ' + (v.requests || 0) + ' req, ~' + tok.toLocaleString() + ' tokens' + costStr + '</li>';
          }).join('');
        }
        if (usageModelComparisonEl && data.modelComparison && data.modelComparison.length > 1) {
          usageModelComparisonEl.style.display = 'block';
          usageModelComparisonEl.innerHTML = '<p class="usage-model-comparison-title">Model comparison</p><ul class="usage-by-model-list">' +
            data.modelComparison.map(function (m) {
              return '<li>' + escapeHtml(m.model) + ': ' + m.requests + ' req, ~' + (m.tokens || 0).toLocaleString() + ' tokens' +
                (m.cost ? ', $' + m.cost.toFixed(4) : '') + '</li>';
            }).join('') + '</ul>';
        } else if (usageModelComparisonEl) {
          usageModelComparisonEl.style.display = 'none';
        }
        const exportBase = '/api/analytics/export?days=' + days + wsParam;
        if (usageExportCsv) {
          usageExportCsv.href = exportBase + '&format=csv';
          usageExportCsv.style.display = 'inline-block';
          usageExportCsv.onclick = async function (e) {
            if (typeof getStorageHeaders === 'function' && Object.keys(getStorageHeaders()).length > 0) {
              e.preventDefault();
              try {
                const r = await fetch(exportBase + '&format=csv', getStorageFetchOptions());
                if (!r.ok) throw new Error('Export failed');
                const blob = await r.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'analytics-' + days + 'd.csv';
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (err) {
                usageStatusEl.textContent = 'Export failed: ' + (err.message || 'Error');
              }
            }
          };
        }
        if (usageExportJson) {
          usageExportJson.href = exportBase + '&format=json';
          usageExportJson.style.display = 'inline-block';
          usageExportJson.onclick = async function (e) {
            if (typeof getStorageHeaders === 'function' && Object.keys(getStorageHeaders()).length > 0) {
              e.preventDefault();
              try {
                const r = await fetch(exportBase + '&format=json', getStorageFetchOptions());
                if (!r.ok) throw new Error('Export failed');
                const blob = await r.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'analytics-' + days + 'd.json';
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (err) {
                usageStatusEl.textContent = 'Export failed: ' + (err.message || 'Error');
              }
            }
          };
        }
        if (usageAnalyticsEl) usageAnalyticsEl.style.display = 'block';
      } catch (err) {
        usageStatusEl.textContent = 'Failed to load: ' + (err.message || 'Error');
      }
    }

    if (usageToggle) {
      usageToggle.addEventListener('toggle', () => {
        if (usageToggle.open) loadUsageStatus();
      });
    }
    if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', () => loadUsageStatus());
    if (usageDaysSelect) usageDaysSelect.addEventListener('change', () => loadUsageStatus());

    // --- Phase 7: Full status report ---
    const fullReportBtn = document.getElementById('full-report-btn');
    const statusReportModal = document.getElementById('status-report-modal');
    const statusReportBody = document.getElementById('status-report-body');
    const statusReportClose = document.getElementById('status-report-close');
    if (fullReportBtn && statusReportModal) {
      fullReportBtn.addEventListener('click', async () => {
        fullReportBtn.disabled = true;
        try {
          const res = await fetch('/api/status/report');
          const data = await res.json();
          const txt = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
          if (statusReportBody) statusReportBody.textContent = txt;
          statusReportModal.classList.add('visible');
        } catch (err) {
          if (statusReportBody) statusReportBody.textContent = 'Error: ' + (err.message || 'Failed to fetch');
          statusReportModal.classList.add('visible');
        } finally {
          fullReportBtn.disabled = false;
        }
      });
    }
    if (statusReportClose && statusReportModal) {
      statusReportClose.addEventListener('click', () => statusReportModal.classList.remove('visible'));
    }

    // --- Phase 5: Context panel ---
    const contextList = document.getElementById('context-list');
    const contextAddBtn = document.getElementById('context-add-btn');
    const contextUploadBtn = document.getElementById('context-upload-btn');
    const contextFileInput = document.getElementById('context-file');
    const contextAddModal = document.getElementById('context-add-modal');
    const contextAddTitleInput = document.getElementById('context-add-title-input');
    const contextAddContentInput = document.getElementById('context-add-content-input');
    const contextAddSave = document.getElementById('context-add-save');
    const contextAddCancel = document.getElementById('context-add-cancel');
    const contextUseRagCheckbox = document.getElementById('context-use-rag');

    function renderContextList() {
      if (!contextList) return;
      const docs = loadContextDocuments();
      contextList.innerHTML = docs.length === 0
        ? '<li class="empty" style="color:#64748b;list-style:none;padding:0.5rem;">No context documents</li>'
        : docs.map(d => {
            const title = escapeHtml((d.title || 'Untitled').slice(0, 60));
            const id = escapeHtml(String(d.id || ''));
            return `<li class="context-doc-item" data-id="${id}"><div><span class="doc-title">${title}</span><span class="doc-meta">${(d.content || '').length} chars</span></div><div class="context-actions"><button type="button" class="btn-delete context-delete-btn" aria-label="Delete ${title}">Delete</button></div></li>`;
          }).join('');
      contextList.querySelectorAll('.context-delete-btn').forEach(btn => {
        btn.onclick = () => {
          const li = btn.closest('[data-id]');
          const id = li?.getAttribute('data-id');
          if (!id) return;
          const docs = loadContextDocuments().filter(x => String(x.id || '') !== id);
          saveContextDocuments(docs);
          renderContextList();
        };
      });
    }

    if (contextAddBtn && contextAddModal) {
      contextAddBtn.addEventListener('click', () => {
        if (contextAddTitleInput) contextAddTitleInput.value = '';
        if (contextAddContentInput) contextAddContentInput.value = '';
        contextAddModal._a11yReturnFocus = document.activeElement;
        contextAddModal.style.display = 'flex';
        contextAddTitleInput?.focus();
      });
    }
    if (contextAddSave && contextAddModal) {
      contextAddSave.addEventListener('click', () => {
        const title = (contextAddTitleInput?.value || '').trim() || 'Untitled';
        const content = contextAddContentInput?.value || '';
        const docs = loadContextDocuments();
        docs.push({ id: crypto.randomUUID(), title, content, createdAt: new Date().toISOString() });
        saveContextDocuments(docs);
        renderContextList();
        contextAddModal.style.display = 'none';
        announce('Context document added');
        indexContextDoc({ title, content });
      });
    }
    if (contextAddCancel && contextAddModal) {
      contextAddCancel.addEventListener('click', () => { contextAddModal.style.display = 'none'; });
    }
    if (contextUploadBtn && contextFileInput) {
      contextUploadBtn.addEventListener('click', () => contextFileInput.click());
    }

    const contextSyncBtn = document.getElementById('context-sync-btn');
    const contextLoadBtn = document.getElementById('context-load-btn');
    async function contextSyncWithServer() {
      if (!contextSyncBtn) return;
      contextSyncBtn.disabled = true;
      try {
        const items = loadContextDocuments();
        const workspace = getSelectedWorkspace();
        const headers = getStorageHeaders();
        const clientApiKey = clientApiKeyInput?.value?.trim();
        if (clientApiKey) headers.Authorization = `Bearer ${clientApiKey}`;
        const res = await fetch('/api/context/sync', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ items, workspace }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNotice(err.error || err.hint || 'Sync failed', 'error', false);
          return;
        }
        const data = await res.json();
        const merged = Array.isArray(data?.items) ? data.items : [];
        saveContextDocuments(merged);
        renderContextList();
        announce('Context synced with server');
      } catch (err) {
        showNotice(err.message || 'Sync failed', 'error', false);
      } finally {
        if (contextSyncBtn) contextSyncBtn.disabled = false;
      }
    }
    async function contextLoadFromServer() {
      if (!contextLoadBtn) return;
      contextLoadBtn.disabled = true;
      try {
        const workspace = getSelectedWorkspace();
        const headers = getStorageHeaders();
        const clientApiKey = clientApiKeyInput?.value?.trim();
        if (clientApiKey) headers.Authorization = `Bearer ${clientApiKey}`;
        const res = await fetch(`/api/context?workspace=${encodeURIComponent(workspace)}`, { headers, credentials: 'include' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNotice(err.error || err.hint || 'Load failed', 'error', false);
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        saveContextDocuments(items);
        renderContextList();
        announce('Context loaded from server');
      } catch (err) {
        showNotice(err.message || 'Load failed', 'error', false);
      } finally {
        if (contextLoadBtn) contextLoadBtn.disabled = false;
      }
    }
    if (contextSyncBtn) contextSyncBtn.addEventListener('click', contextSyncWithServer);
    if (contextLoadBtn) contextLoadBtn.addEventListener('click', contextLoadFromServer);

    if (contextFileInput) {
      contextFileInput.addEventListener('change', async (e) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        const title = (file.name || 'Uploaded').replace(/\.[^.]+$/, '') || 'Uploaded';
        const isPdf = (file.name || '').toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
        let content;
        if (isPdf) {
          try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/documents/extract', { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) {
              showNotice(data.hint || data.error || 'PDF extraction failed', 'error', false);
              e.target.value = '';
              return;
            }
            content = (data.text || '').trim();
          } catch (err) {
            showNotice(err.message || 'PDF extraction failed', 'error', false);
            e.target.value = '';
            return;
          }
        } else {
          content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
          });
        }
        const docs = loadContextDocuments();
        docs.push({ id: crypto.randomUUID(), title, content, createdAt: new Date().toISOString() });
        saveContextDocuments(docs);
        renderContextList();
        announce('Context added from file');
        indexContextDoc({ title, content });
        e.target.value = '';
      });
    }
    if (contextUseRagCheckbox) {
      try {
        contextUseRagCheckbox.checked = localStorage.getItem(CONTEXT_RAG_STORAGE_KEY) === '1';
      } catch (_) {}
      contextUseRagCheckbox.addEventListener('change', () => {
        try {
          if (contextUseRagCheckbox.checked) localStorage.setItem(CONTEXT_RAG_STORAGE_KEY, '1');
          else localStorage.removeItem(CONTEXT_RAG_STORAGE_KEY);
        } catch (_) {}
      });
    }
    const contextUseSemanticCheckbox = document.getElementById('context-use-semantic');
    if (contextUseSemanticCheckbox) {
      try {
        contextUseSemanticCheckbox.checked = localStorage.getItem(CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY) === '1';
      } catch (_) {}
      contextUseSemanticCheckbox.addEventListener('change', () => {
        try {
          if (contextUseSemanticCheckbox.checked) localStorage.setItem(CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY, '1');
          else localStorage.removeItem(CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY);
        } catch (_) {}
      });
    }
    renderContextList();

    // --- Phase 11: Image upload for chat (vision) ---
    const imageUploadInput = document.getElementById('image-upload');
    const imageUploadBtn = document.getElementById('image-upload-btn');
    const attachedImagesWrap = document.getElementById('attached-images-wrap');
    const attachedImagesEl = document.getElementById('attached-images');
    const clearAttachmentsBtn = document.getElementById('clear-attachments');
    const IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB

    function supportsVision(modelName, backend) {
      if (backend === 'openai') return true;
      if (backend === 'ollama' || backend === 'vllm') return /llava|vision|llava2|llava3/i.test(String(modelName || ''));
      return false;
    }

    function renderAttachedImages() {
      if (!attachedImagesEl || !attachedImagesWrap) return;
      attachedImagesWrap.style.display = attachedImages.length ? 'block' : 'none';
      attachedImagesEl.innerHTML = attachedImages.map((dataUrl, _i) => `
        <div class="attached-image-preview"><img src="${dataUrl}" alt="Attached"/><button type="button" class="remove-img" aria-label="Remove image">×</button></div>
      `).join('');
      attachedImagesEl.querySelectorAll('.remove-img').forEach((btn, i) => {
        btn.onclick = () => {
          attachedImages.splice(i, 1);
          renderAttachedImages();
        };
      });
    }

    if (imageUploadBtn && imageUploadInput) {
      imageUploadBtn.addEventListener('click', () => imageUploadInput.click());
    }
    if (imageUploadInput) {
      imageUploadInput.addEventListener('change', (e) => {
        const files = e.target?.files;
        if (!files?.length) return;
        for (const file of files) {
          if (file.size > IMAGE_MAX_SIZE) {
            showNotice(`Image ${file.name} exceeds 5MB`, 'warning', false);
            continue;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            if (dataUrl && typeof dataUrl === 'string') attachedImages.push(dataUrl);
            renderAttachedImages();
          };
          reader.readAsDataURL(file);
        }
        e.target.value = '';
      });
    }
    if (clearAttachmentsBtn) {
      clearAttachmentsBtn.addEventListener('click', () => {
        attachedImages = [];
        renderAttachedImages();
      });
    }

    // --- Phase 6: Recipes panel ---
    const recipesList = document.getElementById('recipes-list');
    const recipeCreateBtn = document.getElementById('recipe-create-btn');
    // const recipesSyncBtn = document.getElementById('recipes-sync-btn');
    // const recipesLoadBtn = document.getElementById('recipes-load-btn');
    const recipeCreateModal = document.getElementById('recipe-create-modal');
    const recipeCreateNameInput = document.getElementById('recipe-create-name-input');
    const recipeCreateDescInput = document.getElementById('recipe-create-desc-input');
    const recipeCreateStepsInput = document.getElementById('recipe-create-steps-input');
    const recipeCreateSave = document.getElementById('recipe-create-save');
    const recipeCreateCancel = document.getElementById('recipe-create-cancel');

    function renderRecipesList() {
      if (!recipesList) return;
      const recipes = loadRecipes();
      recipesList.innerHTML = recipes.length === 0
        ? '<li class="empty" style="color:#64748b;list-style:none;padding:0.5rem;">No recipes</li>'
        : recipes.map(r => {
            const name = escapeHtml((r.name || 'Untitled').slice(0, 50));
            const id = escapeHtml(String(r.id || ''));
            const stepCount = Array.isArray(r.steps) ? r.steps.length : 0;
            return `<li class="recipe-item" data-id="${id}"><div><span class="recipe-name">${name}</span><span class="recipe-meta">${stepCount} steps</span></div><div class="recipe-actions"><button type="button" class="recipe-run-btn" aria-label="Run ${name}">Run</button><button type="button" class="recipe-schedule-btn" aria-label="Schedule ${name}">Schedule</button><button type="button" class="btn-delete recipe-delete-btn" aria-label="Delete ${name}">Delete</button></div></li>`;
          }).join('');
      recipesList.querySelectorAll('.recipe-run-btn').forEach(btn => {
        btn.onclick = () => {
          const li = btn.closest('[data-id]');
          const id = li?.getAttribute('data-id');
          const recipe = loadRecipes().find(x => String(x.id || '') === id);
          if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) return;
          const plan = { type: 'task', id: recipe.id, name: recipe.name || 'Recipe', steps: recipe.steps, requiresApproval: false };
          if (typeof renderTaskPlanCard === 'function') renderTaskPlanCard(plan);
          announce('Recipe loaded into task planner');
        };
      });
      recipesList.querySelectorAll('.recipe-delete-btn').forEach(btn => {
        btn.onclick = () => {
          const li = btn.closest('[data-id]');
          const id = li?.getAttribute('data-id');
          if (!id) return;
          const recipes = loadRecipes().filter(x => String(x.id || '') !== id);
          saveRecipes(recipes);
          renderRecipesList();
        };
      });
      recipesList.querySelectorAll('.recipe-schedule-btn').forEach(btn => {
        btn.onclick = () => {
          const li = btn.closest('[data-id]');
          const id = li?.getAttribute('data-id');
          const recipe = loadRecipes().find(x => String(x.id || '') === id);
          if (!recipe) return;
          openScheduleModal(recipe);
        };
      });
    }

    const scheduleModal = document.getElementById('recipe-schedule-modal');
    const scheduleCronInput = document.getElementById('schedule-cron-input');
    const schedulePreset = document.getElementById('schedule-preset');
    const scheduleTimezoneInput = document.getElementById('schedule-timezone-input');
    const scheduleEnabled = document.getElementById('schedule-enabled');
    const scheduleNextRun = document.getElementById('schedule-next-run');
    const scheduleSave = document.getElementById('schedule-save');
    const scheduleRemove = document.getElementById('schedule-remove');
    const scheduleCancel = document.getElementById('schedule-cancel');
    const scheduledRecipesList = document.getElementById('scheduled-recipes-list');
    let _scheduleModalRecipeId = null;

    function getApiHeaders() {
      const h = typeof getStorageHeaders === 'function' ? getStorageHeaders() : { 'Content-Type': 'application/json' };
      const key = clientApiKeyInput?.value?.trim();
      if (key) h.Authorization = 'Bearer ' + key;
      return h;
    }

    async function openScheduleModal(recipe) {
      // const returnTo = document.activeElement;
      _scheduleModalRecipeId = recipe.id;
      const nameEl = document.getElementById('recipe-schedule-name');
      if (nameEl) nameEl.textContent = recipe.name || 'Recipe';
      if (scheduleCronInput) scheduleCronInput.value = '0 9 * * 1-5';
      if (schedulePreset) schedulePreset.value = '';
      if (scheduleTimezoneInput) scheduleTimezoneInput.value = '';
      if (scheduleEnabled) scheduleEnabled.checked = true;
      if (scheduleNextRun) scheduleNextRun.textContent = '';
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      try {
        const res = await fetch(`/api/schedules?workspace=${encodeURIComponent(workspace)}`, { headers: getApiHeaders() });
        if (res.ok) {
          const data = await res.json();
          const existing = (data.items || []).find(s => String(s.recipeId) === String(recipe.id));
          if (existing) {
            if (scheduleCronInput) scheduleCronInput.value = existing.cron || '';
            if (scheduleTimezoneInput) scheduleTimezoneInput.value = existing.timezone || '';
            if (scheduleEnabled) scheduleEnabled.checked = !!existing.enabled;
            updateScheduleNextRun(existing.cron, existing.timezone);
          }
        }
      } catch (_) {}
      if (scheduleModal) {
        scheduleModal.style.display = 'flex';
        const first = scheduleModal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (first) first.focus();
      }
    }

    async function updateScheduleNextRun(cron, tz) {
      if (!scheduleNextRun || !cron) return;
      try {
        const mod = await import('https://esm.sh/cron-parser@4.9.0');
        const parse = mod.parseExpression || mod.default?.parseExpression;
        if (parse) {
          const opts = { currentDate: new Date() };
          if (tz) opts.tz = tz;
          const interval = parse(cron, opts);
          const next = interval.next();
          scheduleNextRun.textContent = 'Next run: ' + next.toDate().toLocaleString();
        } else scheduleNextRun.textContent = '';
      } catch (_) {
        scheduleNextRun.textContent = 'Enter valid cron to see next run';
      }
    }

    async function renderScheduledRecipesList() {
      if (!scheduledRecipesList) return;
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      try {
        const res = await fetch(`/api/schedules?workspace=${encodeURIComponent(workspace)}`, { headers: getApiHeaders() });
        if (!res.ok) {
          scheduledRecipesList.innerHTML = '<li class="empty" style="color:#64748b;list-style:none;padding:0.5rem;">No scheduled recipes</li>';
          return;
        }
        const data = await res.json();
        const items = (data.items || []).filter(s => s.enabled && s.cron);
        scheduledRecipesList.innerHTML = items.length === 0
          ? '<li class="empty" style="color:#64748b;list-style:none;padding:0.5rem;">None scheduled</li>'
          : items.map(s => {
              const name = escapeHtml((s.recipeName || s.recipeId || 'Recipe').slice(0, 40));
              return `<li class="recipe-item"><span class="recipe-name">${name}</span> <span class="recipe-meta">${escapeHtml(s.cron || '')}</span></li>`;
            }).join('');
      } catch (_) {
        scheduledRecipesList.innerHTML = '<li class="empty" style="color:#64748b;list-style:none;padding:0.5rem;">—</li>';
      }
    }

    if (schedulePreset) schedulePreset.addEventListener('change', () => {
      if (schedulePreset.value && scheduleCronInput) scheduleCronInput.value = schedulePreset.value;
    });
    if (scheduleCronInput) scheduleCronInput.addEventListener('blur', () => {
      updateScheduleNextRun(scheduleCronInput.value, scheduleTimezoneInput?.value);
    });
    if (scheduleSave) scheduleSave.addEventListener('click', async () => {
      if (!_scheduleModalRecipeId) return;
      const cron = (scheduleCronInput?.value || '').trim();
      if (!cron) { showNotice('Cron required', 'warning', false); return; }
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      try {
        const res = await fetch('/api/schedules', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify({ recipeId: _scheduleModalRecipeId, cron, timezone: (scheduleTimezoneInput?.value || '').trim() || undefined, enabled: scheduleEnabled?.checked !== false, workspace }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNotice(err.error || err.hint || 'Failed to save schedule', 'error', false);
          return;
        }
        scheduleModal.style.display = 'none';
        renderScheduledRecipesList();
        announce('Schedule saved');
      } catch (e) {
        showNotice(e.message || 'Failed', 'error', false);
      }
    });
    if (scheduleRemove) scheduleRemove.addEventListener('click', async () => {
      if (!_scheduleModalRecipeId) return;
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      try {
        const res = await fetch(`/api/schedules/${encodeURIComponent(_scheduleModalRecipeId)}?workspace=${encodeURIComponent(workspace)}`, { method: 'DELETE', headers: getApiHeaders() });
        if (res.ok) {
          scheduleModal.style.display = 'none';
          renderScheduledRecipesList();
          announce('Schedule removed');
        } else {
          const err = await res.json().catch(() => ({}));
          showNotice(err.error || 'Failed to remove', 'error', false);
        }
      } catch (e) {
        showNotice(e.message || 'Failed', 'error', false);
      }
    });
    if (scheduleCancel) scheduleCancel.addEventListener('click', () => { scheduleModal.style.display = 'none'; });

    const recipesToggle = document.getElementById('recipes-toggle');
    if (recipesToggle) recipesToggle.addEventListener('toggle', () => { if (recipesToggle.open) renderScheduledRecipesList(); });

    // Phase 17: Fetch available actions for recipe steps dropdown
    async function loadRecipeActions() {
      const hintEl = document.getElementById('recipe-actions-hint');
      const selectEl = document.getElementById('recipe-add-step-select');
      const defaultActions = ['build', 'deploy', 'copy', 'webhook'];
      try {
        const headers = typeof getStorageHeaders === 'function' ? getStorageHeaders() : {};
        const res = await fetch('/api/plugins/actions', { headers });
        const actions = res.ok ? (await res.json()).actions || defaultActions : defaultActions;
        if (hintEl) hintEl.textContent = 'Available actions: ' + (Array.isArray(actions) ? actions.join(', ') : defaultActions.join(', '));
        if (selectEl) {
          const opts = Array.isArray(actions) ? actions : defaultActions;
          selectEl.innerHTML = '<option value="">— Add step —</option>' + opts.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
        }
      } catch (_) {
        if (hintEl) hintEl.textContent = 'Available actions: ' + defaultActions.join(', ');
        if (selectEl) {
          selectEl.innerHTML = '<option value="">— Add step —</option>' + defaultActions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
        }
      }
    }
    const recipeAddStepSelect = document.getElementById('recipe-add-step-select');
    const recipeAddStepBtn = document.getElementById('recipe-add-step-btn');
    if (recipeAddStepSelect && recipeAddStepBtn && recipeCreateStepsInput) {
      recipeAddStepBtn.addEventListener('click', () => {
        const action = recipeAddStepSelect?.value?.trim();
        if (!action) return;
        // const step = JSON.stringify({ action, payload: {} });
        const cur = recipeCreateStepsInput.value.trim();
        let steps = [];
        try {
          if (cur) steps = JSON.parse(cur);
          if (!Array.isArray(steps)) steps = [];
        } catch (_) {}
        steps.push({ action, payload: {} });
        recipeCreateStepsInput.value = JSON.stringify(steps, null, 2);
        recipeAddStepSelect.value = '';
      });
    }
    if (recipeCreateBtn && recipeCreateModal) {
      recipeCreateBtn.addEventListener('click', () => {
        if (recipeCreateNameInput) recipeCreateNameInput.value = '';
        if (recipeCreateDescInput) recipeCreateDescInput.value = '';
        if (recipeCreateStepsInput) recipeCreateStepsInput.value = '';
        recipeCreateModal._a11yReturnFocus = document.activeElement;
        recipeCreateModal.style.display = 'flex';
        loadRecipeActions();
        recipeCreateNameInput?.focus();
      });
    }
    if (recipeCreateSave && recipeCreateModal) {
      recipeCreateSave.addEventListener('click', () => {
        const name = (recipeCreateNameInput?.value || '').trim() || 'Untitled';
        const description = (recipeCreateDescInput?.value || '').trim();
        let steps = [];
        try {
          const raw = (recipeCreateStepsInput?.value || '').trim();
          if (raw) steps = JSON.parse(raw);
          if (!Array.isArray(steps)) steps = [];
        } catch (_) { showNotice('Invalid steps JSON', 'warning', false); return; }
        const recipes = loadRecipes();
        recipes.push({ id: crypto.randomUUID(), name, description, steps, createdAt: new Date().toISOString() });
        saveRecipes(recipes);
        renderRecipesList();
        recipeCreateModal.style.display = 'none';
        announce('Recipe saved');
      });
    }
    if (recipeCreateCancel && recipeCreateModal) {
      recipeCreateCancel.addEventListener('click', () => { recipeCreateModal.style.display = 'none'; });
    }
    renderRecipesList();

    async function initTemplatesAndProfiles() {
      const T = globalThis.SiskelBotTemplates;
      if (!T) return;
      try {
        const defaults = await T.loadDefaults();
        const storedT = T.loadTemplatesFromStorage();
        const storedP = T.loadProfilesFromStorage();
        const templates = T.mergeTemplates(defaults, storedT);
        const profiles = T.mergeProfiles(defaults, storedP);
        window._mergedTemplates = templates;
        window._mergedProfiles = profiles;
        if (templateSelect) {
          const opt = templateSelect.querySelector('option[value=""]');
          templateSelect.innerHTML = opt ? opt.outerHTML : '<option value="">— Template —</option>';
          templates.forEach(t => {
            const o = document.createElement('option');
            o.value = t.id;
            o.textContent = t.name || t.id;
            templateSelect.appendChild(o);
          });
        }
        if (profileSelect) {
          const opt = profileSelect.querySelector('option[value=""]');
          profileSelect.innerHTML = opt ? opt.outerHTML : '<option value="">— Profile —</option>';
          profiles.forEach(p => {
            const o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.name || p.id;
            profileSelect.appendChild(o);
          });
          const activeId = storedP?.activeProfileId || null;
          if (activeId && profiles.some(pr => pr.id === activeId)) {
            profileSelect.value = activeId;
            applyProfile(profiles.find(pr => pr.id === activeId));
          }
        }
      } catch (e) {
        console.warn('SiskelBot: failed to init templates/profiles', e);
      }
    }

    function applyProfile(profile) {
      if (!profile) return;
      if (profile.systemPrompt && systemPromptTextarea) systemPromptTextarea.value = profile.systemPrompt;
      if (profile.model != null && profile.model !== '' && modelInput) modelInput.value = profile.model;
      if (profile.templateId && templateSelect) templateSelect.value = profile.templateId;
    }

    initTemplatesAndProfiles();

    if (profileSelect) {
      profileSelect.addEventListener('change', () => {
        const id = profileSelect.value;
        if (!id) return;
        const profiles = (window._mergedProfiles || []);
        const p = profiles.find(x => x.id === id);
        if (p) applyProfile(p);
        const T = globalThis.SiskelBotTemplates;
        if (T) T.saveProfiles(profiles, id);
      });
    }

    const useCasesChips = document.getElementById('use-cases-chips');
    const useCasesManageBtn = document.getElementById('use-cases-manage-btn');
    const useCasesAddBtn = document.getElementById('use-cases-add-btn');
    const useCasesSettingsList = document.getElementById('use-cases-settings-list');
    const useCaseEditModal = document.getElementById('use-case-edit-modal');
    const useCaseEditId = document.getElementById('use-case-edit-id');
    const useCaseEditName = document.getElementById('use-case-edit-name');
    const useCaseEditProfile = document.getElementById('use-case-edit-profile');
    const useCaseEditSystemPrompt = document.getElementById('use-case-edit-system-prompt');
    const useCaseEditModel = document.getElementById('use-case-edit-model');
    const useCaseEditAgent = document.getElementById('use-case-edit-agent');
    const useCaseEditSwarm = document.getElementById('use-case-edit-swarm');
    const useCaseEditRag = document.getElementById('use-case-edit-rag');
    const useCaseEditSemantic = document.getElementById('use-case-edit-semantic');
    const useCaseEditTemp = document.getElementById('use-case-edit-temp');
    const useCaseEditMax = document.getElementById('use-case-edit-max');
    const useCaseEditSave = document.getElementById('use-case-edit-save');
    const useCaseEditDelete = document.getElementById('use-case-edit-delete');
    const useCaseEditCancel = document.getElementById('use-case-edit-cancel');

    function resolveUseCase(uc) {
      if (!uc) return uc;
      const profiles = window._mergedProfiles || [];
      const templates = window._mergedTemplates || [];
      let base = {};
      if (uc.profileId) {
        const p = profiles.find(x => x.id === uc.profileId);
        if (p) base = { systemPrompt: p.systemPrompt, model: p.model, templateId: p.templateId };
      }
      if (uc.templateId) {
        const t = templates.find(x => x.id === uc.templateId);
        if (t) base = { ...base, systemPrompt: base.systemPrompt || t.systemPrompt, templateId: uc.templateId };
      }
      return {
        name: uc.name,
        systemPrompt: uc.systemPrompt ?? base.systemPrompt ?? '',
        model: uc.model != null && uc.model !== '' ? uc.model : (base.model ?? ''),
        templateId: uc.templateId ?? base.templateId ?? '',
        agentMode: uc.agentMode ?? false,
        swarmMode: uc.swarmMode ?? false,
        useRag: uc.useRag ?? false,
        useSemantic: uc.useSemantic ?? false,
        temperature: uc.temperature ?? 0.7,
        maxTokens: uc.maxTokens ?? 2048
      };
    }

    function applyUseCase(uc) {
      const r = resolveUseCase(uc);
      if (!r) return;
      if (r.systemPrompt && systemPromptTextarea) systemPromptTextarea.value = r.systemPrompt;
      if (modelInput) modelInput.value = r.model || '';
      if (r.templateId && templateSelect) templateSelect.value = r.templateId;
      if (agentModeCheckbox) agentModeCheckbox.checked = r.agentMode;
      if (typeof localStorage !== 'undefined') localStorage.setItem(AGENT_MODE_STORAGE_KEY, r.agentMode ? '1' : '0');
      const swarmCheckbox = document.getElementById('swarm-mode');
      if (swarmCheckbox) swarmCheckbox.checked = r.swarmMode;
      if (typeof localStorage !== 'undefined') localStorage.setItem('siskelbot-swarm-mode', r.swarmMode ? '1' : '0');
      const contextRag = document.getElementById('context-use-rag');
      if (contextRag) contextRag.checked = r.useRag;
      if (typeof localStorage !== 'undefined') localStorage.setItem(CONTEXT_RAG_STORAGE_KEY, r.useRag ? '1' : '0');
      const contextSemantic = document.getElementById('context-use-semantic');
      if (contextSemantic) contextSemantic.checked = r.useSemantic;
      if (typeof localStorage !== 'undefined') localStorage.setItem(CONTEXT_SEMANTIC_SEARCH_STORAGE_KEY, r.useSemantic ? '1' : '0');
      const tempInput = document.getElementById('temperature');
      if (tempInput) tempInput.value = r.temperature;
      const maxInput = document.getElementById('max-tokens');
      if (maxInput) maxInput.value = r.maxTokens;
      if (profileSelect && uc.profileId) profileSelect.value = uc.profileId;
      if (currentInteractionMode !== 'tool-swarm' && typeof syncInteractionModeFromCheckboxes === 'function') {
        syncInteractionModeFromCheckboxes();
      }
    }

    async function initUseCases() {
      const U = globalThis.SiskelBotUseCases;
      if (!U) return;
      try {
        const defaults = await U.loadDefaults();
        const stored = U.loadFromStorage();
        const useCases = U.mergeUseCases(defaults, stored);
        window._mergedUseCases = useCases;
        if (useCasesChips) {
          useCasesChips.innerHTML = '';
          useCases.forEach(uc => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'use-case-chip';
            btn.textContent = uc.name || uc.id;
            btn.setAttribute('data-use-case-id', uc.id);
            btn.addEventListener('click', () => {
              const u = useCases.find(x => x.id === uc.id);
              if (u) {
                applyUseCase(u);
                U.saveUseCases(useCases, uc.id);
                useCasesChips.querySelectorAll('.use-case-chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
              }
            });
            useCasesChips.appendChild(btn);
          });
          const activeId = stored?.activeUseCaseId || null;
          if (activeId) {
            const activeBtn = useCasesChips.querySelector(`[data-use-case-id="${activeId}"]`);
            if (activeBtn) {
              activeBtn.classList.add('active');
              const u = useCases.find(x => x.id === activeId);
              if (u) applyUseCase(u);
            }
          }
        }
        if (useCasesSettingsList) {
          useCasesSettingsList.innerHTML = '';
          useCases.forEach(uc => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;';
            row.innerHTML = `<span style="flex:1;">${escapeHtml(uc.name || uc.id)}</span><button type="button" class="header-button use-case-edit-btn" data-id="${escapeHtml(uc.id)}" style="padding:0.2rem 0.4rem;font-size:0.75rem;">Edit</button>`;
            useCasesSettingsList.appendChild(row);
          });
        }
        if (useCaseEditProfile) {
          const profiles = window._mergedProfiles || [];
          const curOpt = useCaseEditProfile.querySelector('option[value=""]');
          useCaseEditProfile.innerHTML = curOpt ? curOpt.outerHTML : '<option value="">— Profile —</option>';
          profiles.forEach(p => {
            const o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.name || p.id;
            useCaseEditProfile.appendChild(o);
          });
        }
      } catch (e) {
        console.warn('SiskelBot: failed to init use cases', e);
      }
    }

    if (useCasesManageBtn) {
      useCasesManageBtn.addEventListener('click', () => {
        const settingsToggle = document.getElementById('settings-toggle');
        if (settingsToggle) {
          settingsToggle.open = true;
        }
      });
    }

    function openUseCaseEditModal(uc) {
      if (!useCaseEditModal) return;
      const isNew = !uc || !uc.id;
      if (useCaseEditId) useCaseEditId.value = isNew ? '' : uc.id;
      if (useCaseEditName) useCaseEditName.value = uc?.name || '';
      if (useCaseEditProfile) useCaseEditProfile.value = uc?.profileId || '';
      if (useCaseEditSystemPrompt) useCaseEditSystemPrompt.value = uc?.systemPrompt || '';
      if (useCaseEditModel) useCaseEditModel.value = uc?.model || '';
      if (useCaseEditAgent) useCaseEditAgent.checked = uc?.agentMode ?? false;
      if (useCaseEditSwarm) useCaseEditSwarm.checked = uc?.swarmMode ?? false;
      if (useCaseEditRag) useCaseEditRag.checked = uc?.useRag ?? false;
      if (useCaseEditSemantic) useCaseEditSemantic.checked = uc?.useSemantic ?? false;
      if (useCaseEditTemp) useCaseEditTemp.value = uc?.temperature ?? 0.7;
      if (useCaseEditMax) useCaseEditMax.value = uc?.maxTokens ?? 2048;
      if (useCaseEditDelete) useCaseEditDelete.style.display = uc?.id?.startsWith('user-') ? '' : 'none';
      useCaseEditModal.style.display = 'flex';
    }

    if (useCasesAddBtn) {
      useCasesAddBtn.addEventListener('click', () => openUseCaseEditModal(null));
    }

    document.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.use-case-edit-btn');
      if (editBtn) {
        const id = editBtn.getAttribute('data-id');
        const useCases = window._mergedUseCases || [];
        const uc = useCases.find(x => x.id === id);
        if (uc) openUseCaseEditModal(uc);
      }
    });

    if (useCaseEditSave) {
      useCaseEditSave.addEventListener('click', () => {
        const useCases = window._mergedUseCases || [];
        const id = useCaseEditId?.value?.trim();
        const name = (useCaseEditName?.value || '').trim();
        if (!name) { showNotice('Name is required', 'warning', false); return; }
        const payload = {
          id: id || 'user-' + crypto.randomUUID(),
          name,
          profileId: useCaseEditProfile?.value || null,
          systemPrompt: (useCaseEditSystemPrompt?.value || '').trim() || null,
          model: (useCaseEditModel?.value || '').trim() || null,
          agentMode: useCaseEditAgent?.checked ?? false,
          swarmMode: useCaseEditSwarm?.checked ?? false,
          useRag: useCaseEditRag?.checked ?? false,
          useSemantic: useCaseEditSemantic?.checked ?? false,
          temperature: Number(useCaseEditTemp?.value) || 0.7,
          maxTokens: Number(useCaseEditMax?.value) || 2048
        };
        if (!payload.profileId) delete payload.profileId;
        let next = useCases;
        if (id) {
          const idx = next.findIndex(x => x.id === id);
          if (idx >= 0) next = [...next]; next[idx] = { ...next[idx], ...payload };
        } else {
          next = [...next, payload];
        }
        window._mergedUseCases = next;
        const U = globalThis.SiskelBotUseCases;
        if (U) U.saveUseCases(next, payload.id);
        initUseCases();
        useCaseEditModal.style.display = 'none';
        announce('Use case saved');
      });
    }

    if (useCaseEditDelete) {
      useCaseEditDelete.addEventListener('click', () => {
        const id = useCaseEditId?.value?.trim();
        if (!id || !id.startsWith('user-')) return;
        const useCases = (window._mergedUseCases || []).filter(x => x.id !== id);
        window._mergedUseCases = useCases;
        const U = globalThis.SiskelBotUseCases;
        if (U) U.saveUseCases(useCases, null);
        initUseCases();
        useCaseEditModal.style.display = 'none';
        announce('Use case deleted');
      });
    }

    if (useCaseEditCancel) {
      useCaseEditCancel.addEventListener('click', () => { useCaseEditModal.style.display = 'none'; });
    }

    initTemplatesAndProfiles().then(() => initUseCases());

    let messages = [];
    let streamStartTime = 0;
    let ttfb = null;
    let assistantSseStreaming = false;

    clientApiKeyInput.value = sessionStorage.getItem(SESSION_API_KEY) || '';
    clientApiKeyInput.addEventListener('input', () => {
      const value = clientApiKeyInput.value.trim();
      if (value) sessionStorage.setItem(SESSION_API_KEY, value);
      else sessionStorage.removeItem(SESSION_API_KEY);
    });
    if (userApiKeyInput) {
      userApiKeyInput.value = sessionStorage.getItem(SESSION_USER_API_KEY) || '';
      userApiKeyInput.addEventListener('input', () => {
        const value = userApiKeyInput.value.trim();
        if (value) sessionStorage.setItem(SESSION_USER_API_KEY, value);
        else sessionStorage.removeItem(SESSION_USER_API_KEY);
      });
    }
    dismissNoticeBtn.onclick = clearNotice;

    function getSystemPromptContent() {
      const custom = systemPromptTextarea.value.trim();
      if (custom) return custom;
      const templateId = templateSelect?.value;
      if (!templateId || !globalThis.SiskelBotTemplates) return '';
      const templates = (window._mergedTemplates || []);
      const t = templates.find(x => x.id === templateId);
      return t?.systemPrompt || '';
    }

    function loadContextDocuments() {
      try {
        const raw = localStorage.getItem(CONTEXT_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }

    function saveContextDocuments(docs) {
      try {
        const arr = Array.isArray(docs) ? docs : [];
        if (arr.length) localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(arr));
        else localStorage.removeItem(CONTEXT_STORAGE_KEY);
      } catch (_) {}
    }

    async function indexContextDoc(docOrOpts) {
      const raw = docOrOpts || {};
      const content = raw.content != null ? raw.content : '';
      if (!String(content).trim()) return;
      const title = raw.title != null ? String(raw.title).trim() : '';
      const storeEmbeddings = document.getElementById('knowledge-store-embeddings')?.checked === true;
      try {
        const res = await fetch('/api/knowledge/index', getStorageFetchOptions({
          method: 'POST',
          body: JSON.stringify({
            text: String(content).trim(),
            title: title || 'Untitled',
            workspace: getSelectedWorkspace(),
            computeEmbedding: storeEmbeddings,
          }),
        }));
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.warn('Knowledge index failed:', data.error || res.statusText);
        }
      } catch (e) {
        console.warn('SiskelBot: failed to index context doc', e);
      }
    }

    function loadRecipes() {
      try {
        const raw = localStorage.getItem(RECIPES_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }

    function saveRecipes(recipes) {
      try {
        const arr = Array.isArray(recipes) ? recipes : [];
        if (arr.length) localStorage.setItem(RECIPES_STORAGE_KEY, JSON.stringify(arr));
        else localStorage.removeItem(RECIPES_STORAGE_KEY);
      } catch (_) {}
    }

    function getContextForApi() {
      const docs = loadContextDocuments();
      if (!docs.length) return '';
      return docs.map((d) => `--- ${(d.title || 'Context').trim()} ---\n${String(d.content || '').trim()}`).filter(Boolean).join('\n\n');
    }

    async function buildApiMessages(userPrompt) {
      let systemContent = getSystemPromptContent();
      const useRag = document.getElementById('context-use-rag')?.checked === true;
      const docs = loadContextDocuments();
      if (docs.length > 0) {
        let contextBlock = '';
        if (useRag && userPrompt && String(userPrompt).trim()) {
          try {
            const useSemantic = document.getElementById('context-use-semantic')?.checked === true;
            const q = encodeURIComponent(String(userPrompt).trim());
            const params = new URLSearchParams({ q, workspace: getSelectedWorkspace() });
            if (useSemantic) params.set('semantic', '1');
            const res = await fetch(`/api/knowledge/search?${params}`, getStorageFetchOptions());
            const data = res.ok ? await res.json() : null;
            const snippets = data?.snippets || [];
            if (snippets.length > 0) {
              const topK = 5;
              contextBlock = 'Relevant context:\n\n' + snippets.slice(0, topK).map(s => (s.title ? `[${s.title}] ` : '') + (s.snippet || '')).join('\n\n');
            }
          } catch (_) {}
        }
        if (!contextBlock) contextBlock = getContextForApi();
        if (contextBlock) systemContent = (systemContent ? systemContent + '\n\n' : '') + '--- Context documents ---\n' + contextBlock;
      }
      const apiMessages = [];
      if (systemContent) apiMessages.push({ role: 'system', content: systemContent });
      return apiMessages.concat(messages);
    }

    function clearHistory() {
      messages = [];
      conversationMeta.pinned = false;
      conversationMeta.tags = [];
      currentConversationId = null;
      while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
      updatePinTagUI();
      persistMessages();
      announce('Chat cleared');
      setConnectionStatus(window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready');
      if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
    }

    // --- Phase 12: Conversation Workspaces & History ---
    function getConversationTitle(msgs) {
      if (!Array.isArray(msgs)) return 'Untitled';
      const first = msgs.find(m => m && m.role === 'user' && typeof m.content === 'string');
      const text = (first?.content || '').trim();
      return text ? text.slice(0, 60) + (text.length > 60 ? '...' : '') : 'Untitled';
    }

    function loadConversations() {
      try {
        const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    function saveConversations(list) {
      try {
        const arr = Array.isArray(list) ? list : [];
        if (arr.length) localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(arr));
        else localStorage.removeItem(CONVERSATIONS_STORAGE_KEY);
      } catch (_) {}
    }

    function saveCurrentToConversations() {
      if (messages.length === 0) return;
      const list = loadConversations();
      const title = getConversationTitle(messages);
      const tags = Array.isArray(conversationMeta.tags) ? conversationMeta.tags : [];
      const pinned = !!conversationMeta.pinned;
      const now = new Date().toISOString();
      let conv = { id: currentConversationId, title, messages: [...messages], pinned, tags, createdAt: now, updatedAt: now };
      if (currentConversationId) {
        const idx = list.findIndex(c => c && String(c.id) === String(currentConversationId));
        if (idx >= 0) {
          conv = { ...list[idx], ...conv, messages: [...messages], title, pinned, tags, updatedAt: now };
          list[idx] = conv;
        } else {
          conv.id = conv.id || crypto.randomUUID();
          currentConversationId = conv.id;
          list.unshift(conv);
        }
      } else {
        conv.id = crypto.randomUUID();
        currentConversationId = conv.id;
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

    let switchToConversation = function switchToConversation(id) {
      saveCurrentToConversations();
      const list = loadConversations();
      const conv = list.find(c => c && String(c.id) === String(id));
      if (!conv || !Array.isArray(conv.messages)) return;
      messages = conv.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
      conversationMeta.pinned = !!conv.pinned;
      conversationMeta.tags = Array.isArray(conv.tags) ? [...conv.tags] : [];
      currentConversationId = conv.id;
      while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
      messages.forEach(m => addMessage(m.role, m.content, null));
      updatePinTagUI();
      persistMessages();
      applySearchFilter();
      if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
      renderConversationsList();
      announce('Switched conversation');
    }

    function renderConversationsList() {
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
          const active = currentConversationId && String(c.id) === String(currentConversationId) ? ' active' : '';
          return `<li class="conversation-item${active}" data-id="${escapeHtml(String(c.id))}" role="button" tabindex="0">` +
            `<span class="conversation-item-title">${title}</span>` +
            `<span class="conversation-item-meta">${escapeHtml(date)}</span>${tagsHtml}</li>`;
        }).join('');
        listEl.querySelectorAll('.conversation-item').forEach(li => {
          li.onclick = () => switchToConversation(li.getAttribute('data-id'));
          li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchToConversation(li.getAttribute('data-id')); } };
        });
      }
      if (matchEl) matchEl.textContent = q ? `${slice.length} / ${filtered.length}` : '';
    }

    const conversationsToggle = document.getElementById('conversations-toggle');
    const conversationsSearch = document.getElementById('conversations-search');
    const conversationsServerActions = document.getElementById('conversations-server-actions');
    const conversationsSyncBtn = document.getElementById('conversations-sync-btn');
    const conversationsLoadBtn = document.getElementById('conversations-load-btn');

    async function checkConversationsApi() {
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
                renderConversationsList();
                showNotice('Loaded from server', 'warning', false);
                setTimeout(clearNotice, 2000);
              } catch (e) { showNotice('Load failed: ' + (e.message || 'network error'), 'error', false); }
            };
          }
        }
      } catch (_) {}
    }

    if (conversationsToggle) {
      conversationsToggle.addEventListener('toggle', () => {
        if (conversationsToggle.open) {
          renderConversationsList();
          checkConversationsApi();
        }
      });
    }
    if (conversationsSearch) {
      conversationsSearch.addEventListener('input', () => renderConversationsList());
      conversationsSearch.addEventListener('search', () => renderConversationsList());
    }

    if (clearBtn) {
      // const origClear = clearBtn.onclick;
      clearBtn.onclick = () => {
        saveCurrentToConversations();
        clearHistory();
      };
    }

    function updatePinTagUI() {
      if (pinBtn) {
        pinBtn.classList.toggle('pinned', conversationMeta.pinned);
        pinBtn.textContent = conversationMeta.pinned ? '\u{1F4CC} Pinned' : '\u{1F4CC} Pin';
      }
      if (tagsInput) tagsInput.value = (conversationMeta.tags || []).join(', ');
    }

    function applySearchFilter() {
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

    if (historySearch) {
      const saved = sessionStorage.getItem(SESSION_SEARCH_KEY);
      if (saved) historySearch.value = saved;
      historySearch.addEventListener('input', applySearchFilter);
      historySearch.addEventListener('search', applySearchFilter);
    }

    if (pinBtn) {
      pinBtn.addEventListener('click', () => {
        conversationMeta.pinned = !conversationMeta.pinned;
        updatePinTagUI();
        persistMessages();
      });
    }

    if (tagsInput) {
      tagsInput.addEventListener('change', () => {
        const raw = (tagsInput.value || '').trim();
        conversationMeta.tags = raw ? raw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        persistMessages();
      });
      tagsInput.addEventListener('blur', () => {
        const raw = (tagsInput.value || '').trim();
        conversationMeta.tags = raw ? raw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        persistMessages();
      });
    }

    if (templateSelect) {
      templateSelect.addEventListener('change', () => {
        const templateId = templateSelect.value;
        if (!templateId) return;
        const templates = (window._mergedTemplates || []);
        const t = templates.find(x => x.id === templateId);
        if (t) {
          systemPromptTextarea.value = t.systemPrompt || '';
          if (t.model && modelInput) modelInput.value = t.model;
        }
      });
    }

    if (clearBtn) clearBtn.onclick = () => { saveCurrentToConversations(); clearHistory(); };

    function scrollToBottom() {
      if (!chatContainer) return;
      scheduleDom(function () {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }

    function pruneChatDom(maxKeep) {
      if (!chatContainer) return;
      const cap = maxKeep || MAX_CHAT_DOM_MESSAGES;
      const msgs = chatContainer.querySelectorAll('.message');
      if (msgs.length <= cap) return;
      const drop = msgs.length - cap;
      for (let i = 0; i < drop; i++) {
        msgs[i].remove();
      }
    }

    function addMessage(role, content, meta = null) {
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
      attachBranchButton(el);
      scrollToBottom();
      announce(`${label} message added`);
      return el;
    }

    function addTypingIndicator() {
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

    function removeTypingIndicator() {
      const el = document.getElementById('typing-indicator');
      if (el) el.remove();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // --- Voice: Text-to-Speech ---
    const synth = window.speechSynthesis;
    // let currentUtterance = null;

    function speakText(text, onEnd) {
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
      // currentUtterance = u;
      synth.speak(u);
    }

    function attachSpeakerButton(msgEl) {
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

    // --- Conversation Branching ---
    function getMessageIndex(msgEl) {
      const allMsgs = chatContainer.querySelectorAll('.message');
      for (let i = 0; i < allMsgs.length; i++) {
        if (allMsgs[i] === msgEl) return i;
      }
      return -1;
    }

    function attachBranchButton(msgEl) {
      const btn = msgEl.querySelector('.btn-branch');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const idx = getMessageIndex(msgEl);
        if (idx < 0) return;
        if (!currentConversationId) {
          saveCurrentToConversations();
        }
        if (!currentConversationId) return;
        const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        try {
          btn.disabled = true;
          btn.textContent = '...';
          const resp = await fetch('/api/conversations/' + encodeURIComponent(currentConversationId) + '/branch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ atMessageIndex: idx, workspace: ws }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            alert('Branch failed: ' + (err.error || resp.statusText));
            return;
          }
          const branch = await resp.json();
          // Save the branch locally as a conversation and switch to it
          const list = loadConversations();
          list.unshift({
            id: branch.id,
            title: branch.title,
            messages: branch.messages,
            pinned: false,
            tags: branch.tags || [],
            createdAt: branch.createdAt,
            updatedAt: branch.updatedAt,
            _isBranch: true,
            parentConversationId: branch.parentConversationId,
            branchPoint: branch.branchPoint,
            label: branch.label,
          });
          saveConversations(list);
          switchToConversation(branch.id);
          updateBranchIndicator();
          announce('Branched conversation at message ' + idx);
        } catch (e) {
          alert('Branch failed: ' + (e.message || 'Network error'));
        } finally {
          btn.disabled = false;
          btn.textContent = '\u2B57 Branch';
        }
      });
    }

    async function updateBranchIndicator() {
      const indicator = document.getElementById('branch-indicator');
      const badge = document.getElementById('branch-badge');
      const selector = document.getElementById('branch-selector');
      if (!indicator || !badge || !selector) return;

      if (!currentConversationId) {
        indicator.style.display = 'none';
        return;
      }

      // Check if this conversation is a branch
      const list = loadConversations();
      const current = list.find(c => c && String(c.id) === String(currentConversationId));
      const parentId = current?._isBranch ? current.parentConversationId : currentConversationId;

      // Find all branches of the parent (or self)
      const branches = list.filter(c => c && c._isBranch && String(c.parentConversationId) === String(parentId));
      const parent = list.find(c => c && String(c.id) === String(parentId));

      if (branches.length === 0) {
        indicator.style.display = 'none';
        return;
      }

      indicator.style.display = 'flex';
      if (current?._isBranch) {
        badge.textContent = '\u2B57 Branch';
        // Add visual indicator to all messages
        chatContainer.querySelectorAll('.message').forEach(m => m.classList.add('branched-conv'));
      } else {
        badge.textContent = branches.length + ' branch' + (branches.length > 1 ? 'es' : '');
      }

      // Populate the selector
      selector.innerHTML = '';
      const parentOpt = document.createElement('option');
      parentOpt.value = parentId;
      parentOpt.textContent = (parent?.title || 'Original').slice(0, 40);
      if (String(currentConversationId) === String(parentId)) parentOpt.selected = true;
      selector.appendChild(parentOpt);

      branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = ('\u2B57 ' + (b.label || b.title || 'Branch')).slice(0, 40);
        if (String(currentConversationId) === String(b.id)) opt.selected = true;
        selector.appendChild(opt);
      });
    }

    // Branch selector change handler
    (function() {
      const selector = document.getElementById('branch-selector');
      if (selector) {
        selector.addEventListener('change', () => {
          const id = selector.value;
          if (id && String(id) !== String(currentConversationId)) {
            switchToConversation(id);
          }
        });
      }
    })();

    // Update branch indicator on conversation switch
    const _origSwitchToConversation = switchToConversation;
    switchToConversation = function(id) {
      _origSwitchToConversation(id);
      updateBranchIndicator();
    };

    // --- Voice: Speech-to-Text ---
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = document.getElementById('mic-btn');
    const autoSpeakCheckbox = document.getElementById('auto-speak');

    if (micBtn) {
      if (SpeechRecognitionAPI) {
        micBtn.disabled = false;
        micBtn.title = 'Click to start voice input (speech-to-text)';
        let recognition = null;
        let isListening = false;

        micBtn.addEventListener('click', () => {
        if (isListening) {
          if (recognition) recognition.stop();
          return;
        }
        recognition = new SpeechRecognitionAPI();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
          isListening = true;
          micBtn.classList.add('listening');
        };
        recognition.onend = () => {
          isListening = false;
          micBtn.classList.remove('listening');
        };
        recognition.onerror = (e) => {
          if (e.error !== 'aborted') {
            isListening = false;
            micBtn.classList.remove('listening');
          }
        };
        recognition.onresult = (e) => {
          let final = '';
          // let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const result = e.results[i];
            const transcript = result[0].transcript;
            if (result.isFinal) {
              final += transcript;
            } else {
              // interim += transcript;
            }
          }
          if (final) {
            const sep = promptInput.value && !promptInput.value.endsWith(' ') ? ' ' : '';
            promptInput.value += sep + final;
          }
        };

        recognition.start();
      });
      } else {
        micBtn.title = 'Speech-to-text not supported (Chrome/Edge recommended)';
      }
    }

    function renderAssistantMarkdown(text) {
      if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        return escapeHtml(text);
      }
      const raw = marked.parse(text || '', { async: false });
      return DOMPurify.sanitize(raw || '', { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'a', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'] });
    }

    function updateAssistantContent(el, content, meta) {
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

    function formatAgentLimitsHud(resHeaders, agentActivity) {
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
      if (runId) parts.push('Run ' + runId.slice(0, 8) + '…');
      const sr = agentActivity && agentActivity.stopReason;
      if (sr && sr !== 'model_finished') parts.push('Reason: ' + String(sr).replace(/_/g, ' '));
      return parts.length ? parts.join(' · ') : '';
    }

    function renderAgentProgressHtml(ev) {
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
      const llm = ev.llmMs != null ? `${ev.llmMs}ms` : '—';
      const tw = ev.toolsWallMs != null ? `${ev.toolsWallMs}ms` : '—';
      return `<div class="agent-progress-strip" role="status" aria-live="polite"><div class="agent-progress-title">Iteration ${escapeHtml(String(ev.iteration))} · LLM ${escapeHtml(llm)} · Tools wall ${escapeHtml(tw)}</div><ul class="agent-progress-tools">${toolEls}</ul></div>`;
    }

    function renderAgentActivityBlock(toolCalls, swarmSteps, iteration) {
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

    function createAssistantBubble(content, meta, activityHtml) {
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

    stopBtn.onclick = () => {
      if (activeAbortController) {
        activeAbortController.abort();
      }
    };

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (stopBtn && stopBtn.style.display !== 'none' && activeAbortController) {
        e.preventDefault();
        stopBtn.click();
      }
    });

    retryLastBtn.onclick = () => {
      if (!lastSubmittedPrompt) return;
      promptInput.value = lastSubmittedPrompt;
      clearNotice();
      sendBtn.click();
    };

    // --- Task planning (Phase 3: Action-Oriented Agent) ---
    const TASKS_PLAN_API = '/v1/tasks/plan';
    const planTaskBtn = document.getElementById('plan-task-btn');
    const approvalModal = document.getElementById('approval-modal');
    const approvalConfirm = document.getElementById('approval-confirm');
    const approvalCancel = document.getElementById('approval-cancel');

    // function isTaskOriented(text) {
    //   if (!text || typeof text !== 'string') return false;
    //   const lower = text.toLowerCase();
    //   const keywords = ['deploy', 'execute', 'run', 'build', 'install', 'setup', 'create', 'delete', 'restart', 'push', 'publish'];
    //   return keywords.some(k => lower.includes(k));
    // }

    function updatePlanTaskButtonState() {
      if (!planTaskBtn) return;
      const draft = (promptInput?.value || '').trim();
      const hasMessages = messages.length > 0;
      const canPlan = hasMessages || !!draft;
      planTaskBtn.disabled = !canPlan;
      planTaskBtn.title = canPlan
        ? 'Structured task plan from the LLM (uses chat history and optional draft in the box)'
        : 'Type a goal or send a message first';
    }

    function formatPlanForClipboard(plan) {
      const lines = ['Run these steps:', '', plan.name || 'Task', ''];
      (plan.steps || []).forEach((s, i) => {
        lines.push(`${i + 1}. ${s.action}`);
        if (s.payload && Object.keys(s.payload).length) {
          lines.push(`   ${JSON.stringify(s.payload)}`);
        }
      });
      return lines.join('\n');
    }

    function getAllowRecipeExecution() {
      try {
        return localStorage.getItem(RECIPE_EXECUTION_STORAGE_KEY) === '1';
      } catch (_) { return false; }
    }

    function renderTaskPlanCard(plan, _raw) {
      const card = document.createElement('div');
      card.className = 'task-plan-card';
      const stepsHtml = (plan.steps || []).map((s, i) => {
        const payload = s.payload && Object.keys(s.payload).length ? `<div class="step-payload">${escapeHtml(JSON.stringify(s.payload))}</div>` : '';
        return `<li class="task-plan-step"><span class="step-action">${i + 1}. ${escapeHtml(s.action)}</span>${payload}</li>`;
      }).join('');
      const approvalHtml = plan.requiresApproval ? '<div class="task-plan-approval">Requires approval before execution</div>' : '';
      card.innerHTML = `
        <div class="task-plan-title">${escapeHtml(plan.name || 'Task plan')}</div>
        ${approvalHtml}
        <ol class="task-plan-steps">${stepsHtml}</ol>
        <div class="task-plan-actions">
          <button type="button" class="btn-copy-plan">Copy plan</button>
          <button type="button" class="btn-execute">Execute</button>
        </div>
      `;
      const copyBtn = card.querySelector('.btn-copy-plan');
      const executeBtn = card.querySelector('.btn-execute');
      copyBtn.onclick = () => {
        const text = formatPlanForClipboard(plan);
        navigator.clipboard.writeText(text).then(() => {
          showNotice('Plan copied to clipboard', 'warning', false);
          setTimeout(clearNotice, 2000);
        }).catch(() => showNotice('Failed to copy', 'error', false));
      };

      const doExecute = async () => {
        const allowExecution = getAllowRecipeExecution();
        const text = formatPlanForClipboard(plan);

        if (!allowExecution || !config.allowRecipeStepExecution) {
          navigator.clipboard.writeText(text).then(() => {
            showNotice(allowExecution
              ? 'Server does not allow step execution. Set ALLOW_RECIPE_STEP_EXECUTION=1. Plan copied to clipboard.'
              : 'Plan copied to clipboard. Enable "Allow recipe step execution" in Settings to run steps on server.',
              'warning', false);
            setTimeout(clearNotice, 4000);
          }).catch(() => showNotice('Failed to copy', 'error', false));
          return;
        }

        const headers = { 'Content-Type': 'application/json' };
        const clientApiKey = clientApiKeyInput?.value?.trim();
        if (clientApiKey) headers.Authorization = `Bearer ${clientApiKey}`;

        executeBtn.disabled = true;
        setConnectionStatus('Executing...');
        let failed = false;
        for (let i = 0; i < (plan.steps || []).length; i++) {
          const s = plan.steps[i];
          const action = String(s?.action || '').trim().toLowerCase();
          if (action === 'copy') {
            try {
              await navigator.clipboard.writeText(text);
            } catch (_) { showNotice('Copy step failed', 'error', false); failed = true; }
            continue;
          }
          try {
            const res = await fetch('/api/execute-step', {
              method: 'POST',
              headers,
              body: JSON.stringify({ step: s, allowExecution: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              showNotice(data.error || data.hint || `Step ${i + 1} failed`, 'error', false);
              failed = true;
              break;
            }
          } catch (err) {
            showNotice(err.message || `Step ${i + 1} request failed`, 'error', false);
            failed = true;
            break;
          }
        }
        executeBtn.disabled = false;
        setConnectionStatus(window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready');
        if (!failed) {
          showNotice('Steps executed successfully', 'warning', false);
          setTimeout(clearNotice, 3000);
          if (typeof addLocalNotification === 'function') addLocalNotification('recipe_completed', 'Recipe completed', plan?.name || 'Steps executed successfully');
        }
      };
      executeBtn.onclick = () => {
        if (plan.requiresApproval) {
          let resolve;
          const promise = new Promise(r => { resolve = r; });
          approvalModal.classList.add('visible');
          const cleanup = () => {
            approvalModal.classList.remove('visible');
            approvalConfirm.onclick = null;
            approvalCancel.onclick = null;
          };
          approvalConfirm.onclick = () => { cleanup(); resolve(true); };
          approvalCancel.onclick = () => { cleanup(); resolve(false); };
          promise.then(ok => { if (ok) doExecute(); });
        } else {
          doExecute();
        }
      };
      chatContainer.appendChild(card);
      scrollToBottom();
      announce('Task plan displayed');
    }

    async function fetchTaskPlan() {
      const draft = (promptInput?.value || '').trim();
      if (messages.length === 0 && !draft) {
        showNotice('Type a goal or send a message first to plan a task', 'warning', false);
        return;
      }
      let planMessages = messages.slice();
      if (draft && (!planMessages.length || planMessages[planMessages.length - 1]?.content !== draft)) {
        planMessages = planMessages.concat([{ role: 'user', content: draft }]);
      }
      const model = modelInput.value.trim() || config.modelPlaceholder || 'model';
      const headers = { 'Content-Type': 'application/json' };
      const clientApiKey = clientApiKeyInput.value.trim();
      if (clientApiKey) headers.Authorization = `Bearer ${clientApiKey}`;
      planTaskBtn.disabled = true;
      setConnectionStatus('Planning...');
      clearNotice();
      try {
        const res = await fetch(TASKS_PLAN_API, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messages: planMessages,
            model,
            workspace: typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg = data.message || data.error || res.statusText;
          showNotice(msg || 'Task plan failed', 'error', false);
          return;
        }
        if (data.plan) {
          renderTaskPlanCard(data.plan, data.raw);
          if (typeof addLocalNotification === 'function') addLocalNotification('plan_created', 'Plan created', data.plan?.name || 'Task plan created');
        } else showNotice('No plan in response', 'warning', false);
      } catch (err) {
        showNotice(err.message || 'Task plan request failed', 'error', false);
      } finally {
        planTaskBtn.disabled = false;
        setConnectionStatus(window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready');
      }
    }

    if (planTaskBtn) {
      planTaskBtn.onclick = fetchTaskPlan;
      updatePlanTaskButtonState();
    }

    if (promptInput) {
      promptInput.addEventListener('input', () => {
        if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
      });
    }

    function formatToolSwarmMarkdown(data) {
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
          const cap = out.length > 12000 ? out.slice(0, 12000) + '\n…' : out;
          parts.push('```\n' + cap + '\n```');
        }
      });
      return parts.join('\n\n');
    }

    async function runToolSwarmRequest(userText) {
      sendBtn.disabled = true;
      clearNotice();
      setConnectionStatus('Tool swarm…');
      addMessage('user', userText);
      promptInput.value = '';
      addTypingIndicator();
      const headers = { 'Content-Type': 'application/json' };
      const clientApiKey = clientApiKeyInput.value.trim();
      if (clientApiKey) headers.Authorization = 'Bearer ' + clientApiKey;
      if (config.authRequired && typeof getStorageHeaders === 'function') {
        const sh = getStorageHeaders();
        if (sh['x-user-api-key']) headers['x-user-api-key'] = sh['x-user-api-key'];
      }
      const specialists = getSelectedToolSwarmSpecialists();
      const allowExecution = toolSwarmAllowExec && toolSwarmAllowExec.checked === true;
      const workspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
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
        const meta = metaParts.length ? metaParts.join(' · ') : null;
        messages.push({ role: 'user', content: userText });
        messages.push({ role: 'assistant', content: md });
        persistMessages();
        addMessage('assistant', md, meta);
        if (typeof updatePlanTaskButtonState === 'function') updatePlanTaskButtonState();
        if (typeof addLocalNotification === 'function') {
          addLocalNotification('swarm_completed', 'Tool swarm finished', (data.query || '').slice(0, 120));
        }
        setConnectionStatus(window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready');
      } catch (err) {
        removeTypingIndicator();
        addMessage('assistant', '**Tool swarm failed**\n\n' + (err.message || 'Network error'), null).classList.add('error-message');
        showNotice(err.message || 'Request failed', 'error', true);
        setConnectionStatus('Error');
      } finally {
        sendBtn.disabled = false;
      }
    }

    sendBtn.onclick = async () => {
      const model = modelInput.value.trim() || config.modelPlaceholder || 'model';
      const prompt = promptInput.value.trim();

      if (currentInteractionMode === 'tool-swarm') {
        if (!prompt) return;
        if (attachedImages.length) {
          showNotice('Tool swarm is text-only. Remove images or switch mode.', 'warning', false);
          return;
        }
        if (typeof haptic === 'function') haptic('send');
        await runToolSwarmRequest(prompt);
        return;
      }

      if (!prompt && !attachedImages.length) return;
      if (typeof haptic === 'function') haptic('send');

      if (activeAbortController) activeAbortController.abort();
      activeAbortController = new AbortController();
      const signal = activeAbortController.signal;
      lastSubmittedPrompt = prompt;

      sendBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      clearNotice();
      setConnectionStatus('Connecting...');

      const displayPrompt = prompt + (attachedImages.length ? ' 📷' : '');
      addMessage('user', displayPrompt);
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

      attachedImages = [];
      if (typeof renderAttachedImages === 'function') renderAttachedImages();

      const isAgentMode = agentModeCheckbox?.checked === true;
      const isSwarmMode = swarmModeCheckbox?.checked === true;
      const workspace = getWorkspace ? getWorkspace() : 'default';
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
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          assistantSseStreaming = false;
          const headers = { 'Content-Type': 'application/json' };
          const clientApiKey = clientApiKeyInput.value.trim();
          if (clientApiKey) {
            headers.Authorization = `Bearer ${clientApiKey}`;
          }
          if (config.authRequired && typeof getStorageHeaders === 'function') {
            const sh = getStorageHeaders();
            if (sh['x-user-api-key']) headers['x-user-api-key'] = sh['x-user-api-key'];
          }
          ttfb = null;
          streamStartTime = performance.now();
          const res = await fetch(API, {
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
            const errCode = errData.code || errData.error?.code;
            const isQuotaExceeded = res.status === 429 && errCode === 'QUOTA_EXCEEDED';
            const isPlanUpgrade = res.status === 402 && errCode === 'PLAN_UPGRADE_REQUIRED';
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
            if (isPlanUpgrade) {
              showNotice(mapped.detail || mapped.summary, 'warning', { openPricing: true });
            }
            throw new Error(mapped.summary + (mapped.detail ? ' — ' + mapped.detail : ''));
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
                        assistantEl = createAssistantBubble('', null, renderAgentProgressHtml(parsed));
                      } else {
                        const strip = assistantEl.querySelector('.agent-progress-strip');
                        if (strip) strip.outerHTML = renderAgentProgressHtml(parsed);
                        else {
                          const header = assistantEl.querySelector('.message-header');
                          if (header) header.insertAdjacentHTML('afterend', renderAgentProgressHtml(parsed));
                        }
                      }
                    });
                    if (typeof announce === 'function') announce('Agent iteration ' + parsed.iteration);
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
                        assistantEl = createAssistantBubble('', null, activityHtml);
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
                        assistantEl = createAssistantBubble(content, metaLine);
                      } else {
                        updateAssistantContent(assistantEl, content, metaLine);
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
            const swarmMeta = parts.join(' · ');
            meta = meta ? `${meta} · ${swarmMeta}` : swarmMeta;
          }
          const hud = formatAgentLimitsHud(res.headers, lastAgentActivity);
          if (hud) meta = meta ? `${meta} · ${hud}` : hud;
          if (assistantEl && meta) updateAssistantContent(assistantEl, content, meta);
          const runIdHdr = res.headers.get('X-Agent-Run-Id');
          if (assistantEl && runIdHdr) attachViewRunButton(assistantEl, runIdHdr);

          if (!content) {
            removeTypingIndicator();
            if (assistantEl) updateAssistantContent(assistantEl, '(No response)', meta);
            else assistantEl = createAssistantBubble('(No response)', meta);
          }

          messages.push({ role: 'assistant', content: content });
          persistMessages();
          setConnectionStatus(window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready');
          if (typeof haptic === 'function') haptic('success');
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
            const cancelledEl = createAssistantBubble('(Cancelled)', null);
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
          const errMsg = 'Error: ' + (lastError?.message || err.message) + '\n\nBackend: ' + backendHint + ' — visit /health to verify.' + modeHint;
          addMessage('assistant', errMsg, null).classList.add('error-message');
          showNotice(lastError?.message || err.message, 'error', true);
          setConnectionStatus('Error');
          if (typeof haptic === 'function') haptic('error');
        }
      }

      activeAbortController = null;
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
      scrollToBottom();
    };

    // --- Init: Continue previous chat? ---
    const continueModal = document.getElementById('continue-modal');
    const continueYes = document.getElementById('continue-yes');
    const continueNo = document.getElementById('continue-no');
    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const importFileInput = document.getElementById('import-file');
    let previousFocusedElement = null;

    function closeContinueModal() {
      continueModal.style.display = 'none';
      previousFocusedElement?.focus?.();
    }

    function handleContinueModalKeydown(event) {
      if (continueModal.style.display !== 'flex') return;
      if (event.key === 'Escape') {
        localStorage.removeItem(STORAGE_KEY);
        closeContinueModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [continueYes, continueNo];
      const currentIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
      } else if (currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      }
    }

    continueModal.addEventListener('keydown', handleContinueModalKeydown);

    const stored = loadFromStorage();
    if (stored && stored.messages && stored.messages.length > 0) {
      previousFocusedElement = document.activeElement;
      continueModal.style.display = 'flex';
      continueYes.focus();
      continueYes.onclick = () => {
        messages = stored.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
        conversationMeta.pinned = !!stored.pinned;
        conversationMeta.tags = Array.isArray(stored.tags) ? [...stored.tags] : [];
        closeContinueModal();
        messages.forEach(m => addMessage(m.role, m.content, null));
        updatePinTagUI();
        persistMessages();
        updateBranchIndicator();
      };
      continueNo.onclick = () => {
        localStorage.removeItem(STORAGE_KEY);
        closeContinueModal();
      };
    }

    function getExportPayload() {
      return {
        messages,
        pinned: conversationMeta.pinned,
        tags: Array.isArray(conversationMeta.tags) ? conversationMeta.tags : [],
        exportedAt: new Date().toISOString(),
      };
    }

    exportBtn.onclick = () => {
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const blob = new Blob([JSON.stringify(getExportPayload(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `chat-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };

    const copyLinkBtn = document.getElementById('copy-link-btn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => {
        const payload = getExportPayload();
        const json = JSON.stringify(payload, null, 2);
        navigator.clipboard.writeText(json).then(() => {
          showNotice('Conversation JSON copied to clipboard', 'warning', false);
          setTimeout(clearNotice, 2000);
        }).catch(() => showNotice('Failed to copy', 'error', false));
      });
    }

    importBtn.onclick = () => importFileInput.click();
    importFileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          let valid = [];
          let pinned = false;
          let tags = [];
          if (Array.isArray(data)) {
            valid = data.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
          } else if (data && typeof data === 'object' && Array.isArray(data.messages)) {
            valid = data.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
            pinned = !!data.pinned;
            tags = Array.isArray(data.tags) ? data.tags : [];
          } else {
            throw new Error('Expected array of messages or object with messages array');
          }
          if (valid.length === 0) throw new Error('No valid messages');
          messages = valid;
          conversationMeta.pinned = pinned;
          conversationMeta.tags = tags;
          while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
          messages.forEach(m => addMessage(m.role, m.content, null));
          updatePinTagUI();
          persistMessages();
          alert('Chat imported successfully.');
        } catch (err) {
          alert('Invalid import file: ' + (err.message || 'Unknown error'));
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    };

    promptInput.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        sendBtn.click();
      }
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', async () => {
        try {
          await navigator.serviceWorker.register('/sw.js');
        } catch (_) {}
      });
    }

    // --- Phase 20: PWA install prompt ---
    let deferredInstallPrompt = null;
    const installBanner = document.getElementById('install-banner');
    const installAppBtn = document.getElementById('install-app-btn');
    const installDismissBtn = document.getElementById('install-dismiss-btn');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1') {
        if (installBanner) installBanner.style.display = 'flex';
      }
    });
    installAppBtn?.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (installBanner) installBanner.style.display = 'none';
    });
    installDismissBtn?.addEventListener('click', () => {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
      if (installBanner) installBanner.style.display = 'none';
    });

    // --- Phase 27: In-App Notification Center ---
    // NOTIFICATIONS_STORAGE_KEY already declared above
    const NOTIFICATIONS_MAX = 100;
    const NOTIFICATIONS_POLL_MS = 30000;
    const notificationsList = document.getElementById('notifications-list');
    const notificationsBadge = document.getElementById('notifications-badge');
    const notificationsEmpty = document.getElementById('notifications-empty');
    const notificationsMarkReadBtn = document.getElementById('notifications-mark-read-btn');
    const notificationsMarkAllReadBtn = document.getElementById('notifications-mark-all-read-btn');

    function loadLocalNotifications() {
      try {
        const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (_) { return []; }
    }
    function saveLocalNotifications(items) {
      const trimmed = items.slice(-NOTIFICATIONS_MAX);
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(trimmed));
    }
    function addLocalNotification(type, title, body) {
      const items = loadLocalNotifications();
      items.push({
        id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9),
        type,
        title,
        body,
        createdAt: new Date().toISOString(),
        read: false,
        _local: true,
      });
      saveLocalNotifications(items);
      renderNotifications();
    }

    async function fetchServerNotifications() {
      const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
      const headers = getApiHeaders ? getApiHeaders() : { credentials: 'include' };
      try {
        const res = await fetch(`/api/notifications?workspace=${encodeURIComponent(ws)}`, { headers, credentials: 'include' });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.items) ? data.items : [];
      } catch (_) { return []; }
    }

    function mergeNotifications(serverItems, localItems) {
      const byId = new Map();
      [...localItems, ...serverItems].forEach((n) => {
        if (!byId.has(n.id)) byId.set(n.id, { ...n });
      });
      return Array.from(byId.values()).sort((a, b) =>
        (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)
      ).slice(0, NOTIFICATIONS_MAX);
    }

    function renderNotifications(merged) {
      if (!notificationsList || !notificationsBadge) return;
      const items = Array.isArray(merged) ? merged : mergeNotifications([], loadLocalNotifications());
      const unread = items.filter((n) => !n.read).length;
      notificationsBadge.textContent = String(unread);
      notificationsBadge.classList.toggle('empty', unread === 0);
      notificationsList.innerHTML = '';
      if (notificationsEmpty) notificationsEmpty.style.display = items.length ? 'none' : 'block';
      items.forEach((n) => {
        const li = document.createElement('li');
        li.className = 'notification-item' + (n.read ? ' read' : ' unread');
        li.setAttribute('role', 'button');
        li.tabIndex = 0;
        li.innerHTML = `<span class="notification-title">${escapeHtml(n.title || '')}</span>` +
          (n.body ? `<span class="notification-body">${escapeHtml(n.body)}</span>` : '') +
          `<span class="notification-meta">${escapeHtml(formatRelativeTime(n.createdAt))}</span>`;
        li.dataset.id = n.id;
        li.dataset.local = n._local ? '1' : '0';
        li.addEventListener('click', () => markOneRead(n.id, !!n._local));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); markOneRead(n.id, !!n._local); } });
        notificationsList.appendChild(li);
      });
    }
    function formatRelativeTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const sec = (Date.now() - d) / 1000;
      if (sec < 60) return 'just now';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
      return d.toLocaleDateString();
    }

    async function markOneRead(id, isLocal) {
      if (isLocal) {
        const items = loadLocalNotifications().map((n) =>
          n.id === id ? { ...n, read: true } : n
        );
        saveLocalNotifications(items);
      } else {
        const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        const headers = getApiHeaders ? getApiHeaders() : { 'Content-Type': 'application/json', credentials: 'include' };
        try {
          await fetch(`/api/notifications/${encodeURIComponent(id)}?workspace=${encodeURIComponent(ws)}`, {
            method: 'PATCH',
            headers,
            credentials: 'include',
          });
        } catch (_) {}
      }
      const server = await fetchServerNotifications();
      renderNotifications(mergeNotifications(server, loadLocalNotifications()));
    }

    async function refreshNotifications() {
      const server = await fetchServerNotifications();
      const local = loadLocalNotifications();
      renderNotifications(mergeNotifications(server, local));
    }

    if (notificationsMarkAllReadBtn) {
      notificationsMarkAllReadBtn.addEventListener('click', async () => {
        const ws = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        const headers = getApiHeaders ? getApiHeaders() : { 'Content-Type': 'application/json', credentials: 'include' };
        try {
          await fetch(`/api/notifications/mark-all-read?workspace=${encodeURIComponent(ws)}`, {
            method: 'PATCH',
            headers,
            credentials: 'include',
          });
        } catch (_) {}
        const items = loadLocalNotifications().map((n) => ({ ...n, read: true }));
        saveLocalNotifications(items);
        refreshNotifications();
      });
    }
    if (notificationsMarkReadBtn) {
      notificationsMarkReadBtn.addEventListener('click', () => {
        const firstUnread = document.querySelector('.notification-item.unread');
        if (firstUnread) markOneRead(firstUnread.dataset.id, firstUnread.dataset.local === '1');
      });
    }

    let notificationsPollTimer = null;
    let notificationsWsConnected = false;
    let notificationsWsManager = null;

    function startNotificationsPoll() {
      if (notificationsPollTimer) return;
      refreshNotifications();
      function tick() {
        if (document.visibilityState === 'visible') refreshNotifications();
        notificationsPollTimer = setTimeout(tick, NOTIFICATIONS_POLL_MS);
      }
      notificationsPollTimer = setTimeout(tick, NOTIFICATIONS_POLL_MS);
    }
    function stopNotificationsPoll() {
      if (notificationsPollTimer) {
        clearTimeout(notificationsPollTimer);
        notificationsPollTimer = null;
      }
    }

    /** Notifications stream: use SiskelWSReconnect.createReconnectingWebSocket (client/js/ws-reconnect.js) — backoff, jitter, queue flush, visibility/offline pauses, heartbeats — not a raw WebSocket. */
    function connectNotificationsWs() {
      if (notificationsWsManager) return;
      if (window.SiskelWSReconnect) {
        const wsWorkspace = typeof getSelectedWorkspace === 'function' ? getSelectedWorkspace() : 'default';
        notificationsWsManager = window.SiskelWSReconnect.createReconnectingWebSocket({
          getTokenUrl: '/api/v1/ws-token',
          workspace: wsWorkspace,
          getTokenHeaders: typeof getApiHeaders === 'function' ? getApiHeaders : undefined,
          onConnect: function () {
            notificationsWsConnected = true;
            stopNotificationsPoll();
          },
          onDisconnect: function () {
            notificationsWsConnected = false;
            startNotificationsPoll();
          },
          onMessage: function (e) {
            try {
              const msg = JSON.parse(e.data);
              if (msg && msg.type === 'notification') refreshNotifications();
            } catch (_) {}
          },
        });
        notificationsWsManager.connect();
        const wsIndicatorEl = document.getElementById('ws-connection-indicator');
        if (wsIndicatorEl) {
          window.SiskelWSReconnect.renderConnectionIndicator(wsIndicatorEl, notificationsWsManager);
        }
      } else {
        startNotificationsPoll();
      }
    }
    function disconnectNotificationsWs() {
      if (notificationsWsManager) {
        notificationsWsManager.disconnect();
        notificationsWsManager = null;
        notificationsWsConnected = false;
      }
    }

    if (document.visibilityState === 'visible') {
      connectNotificationsWs();
      startNotificationsPoll();
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        connectNotificationsWs();
        if (!notificationsWsConnected) startNotificationsPoll();
      } else {
        disconnectNotificationsWs();
        stopNotificationsPoll();
      }
    });
    if (typeof getSelectedWorkspace === 'function' && workspaceSelect) {
      workspaceSelect.addEventListener('change', () => {
        disconnectNotificationsWs();
        connectNotificationsWs();
      });
    }

    refreshNotifications();

    // --- Phase 20: Offline indicator ---
    const offlineIndicator = document.getElementById('offline-indicator');
    function updateOfflineUI() {
      const offline = !navigator.onLine;
      if (offlineIndicator) offlineIndicator.style.display = offline ? 'inline-block' : 'none';
      if (sendBtn) sendBtn.disabled = offline || (stopBtn && stopBtn.style.display === 'inline-block');
      setConnectionStatus(offline ? (window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('header.offline') : 'Offline') : (window.SiskelI18n && SiskelI18n.t ? SiskelI18n.t('status.ready') : 'Ready'));
    }
    updateOfflineUI();
    window.addEventListener('online', updateOfflineUI);
    window.addEventListener('offline', updateOfflineUI);

    // --- Phase 20: Tap-outside-to-close for modals ---
    document.querySelectorAll('[data-modal-overlay]').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target !== overlay) return;
        const returnTo = overlay._a11yReturnFocus;
        if (overlay.id === 'status-report-modal') overlay.classList.remove('visible');
        else if (overlay.id === 'approval-modal') overlay.classList.remove('visible');
        else if (overlay.id === 'continue-modal') closeContinueModal?.();
        else overlay.style.display = 'none';
        if (returnTo && typeof returnTo.focus === 'function') returnTo.focus();
      });
    });

    // --- Phase 26: Modal accessibility (focus trap, Escape, return focus) ---
    function isModalVisible(overlay) {
      if (!overlay) return false;
      if (overlay.id === 'status-report-modal' || overlay.id === 'approval-modal')
        return overlay.classList.contains('visible');
      return overlay.style.display === 'flex';
    }
    function closeModalAndRestore(overlay) {
      if (!overlay) return;
      const returnTo = overlay._a11yReturnFocus;
      if (overlay.id === 'status-report-modal') overlay.classList.remove('visible');
      else if (overlay.id === 'approval-modal') overlay.classList.remove('visible');
      else if (overlay.id === 'continue-modal') { /* handled by closeContinueModal */ return; }
      else overlay.style.display = 'none';
      if (returnTo && typeof returnTo.focus === 'function') returnTo.focus();
    }
    document.querySelectorAll('[data-modal-overlay]').forEach((overlay) => {
      if (overlay.id === 'continue-modal') return; // uses its own handler
      overlay.addEventListener('focusin', (e) => {
        if (!isModalVisible(overlay)) return;
        if (e.relatedTarget && !overlay.contains(e.relatedTarget))
          overlay._a11yReturnFocus = e.relatedTarget;
      });
      overlay.addEventListener('keydown', (e) => {
        if (!isModalVisible(overlay)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          closeModalAndRestore(overlay);
          return;
        }
        if (e.key !== 'Tab') return;
        const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        const focusable = Array.from(overlay.querySelectorAll(sel)).filter(el => !el.hidden && el.offsetParent !== null && !el.disabled);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
    });
    // Focus first focusable when modals using .visible open
    [document.getElementById('status-report-modal'), document.getElementById('approval-modal')].forEach((modal) => {
      if (!modal) return;
      const obs = new MutationObserver(() => {
        if (modal.classList.contains('visible')) {
          modal._a11yReturnFocus = document.activeElement;
          const first = modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (first) first.focus();
        }
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    // --- Phase 20: scrollIntoView on input focus (mobile keyboard) ---
    promptInput?.addEventListener('focus', () => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => promptInput?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' }), 100);
    });

    // --- Phase 20: Haptics ---
    function haptic(type) {
      if (typeof navigator.vibrate !== 'function') return;
      if (type === 'send') navigator.vibrate(10);
      else if (type === 'success') navigator.vibrate([10, 50, 10]);
      else if (type === 'error') navigator.vibrate([20, 50, 20]);
    }
