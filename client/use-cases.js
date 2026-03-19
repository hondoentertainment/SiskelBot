/**
 * SiskelBot use cases - personalization presets.
 * Loads defaults from use-cases.defaults.json and merges with user-created localStorage data.
 * A use case applies: profile/template+model+systemPrompt, agentMode, swarmMode, useRag, useSemantic, temperature, maxTokens.
 */
(function (global) {
  const STORAGE_VERSION = 1;
  const USE_CASES_KEY = 'siskelbot-use-cases';

  const DEFAULTS_FALLBACK = {
    useCases: [
      { id: 'uc-coding', name: 'Coding', profileId: 'profile-coding', agentMode: true, swarmMode: false, useRag: true, useSemantic: false, temperature: 0.7, maxTokens: 2048 },
      { id: 'uc-ops', name: 'Quick ops', profileId: 'profile-quick-ops', agentMode: true, swarmMode: false, useRag: false, useSemantic: false, temperature: 0.4, maxTokens: 1024 },
      { id: 'uc-research', name: 'Research', profileId: 'profile-detailed-research', agentMode: false, swarmMode: false, useRag: true, useSemantic: true, temperature: 0.6, maxTokens: 4096 },
      { id: 'uc-swarm', name: 'Swarm (complex)', profileId: 'profile-swarm', agentMode: true, swarmMode: true, useRag: true, useSemantic: true, temperature: 0.6, maxTokens: 4096 }
    ]
  };

  async function loadDefaults() {
    try {
      const r = await fetch('/use-cases.defaults.json');
      if (r.ok) {
        const data = await r.json();
        if (data?.useCases?.length) return data;
      }
    } catch (_) {}
    return DEFAULTS_FALLBACK;
  }

  function migratePayload(payload, key) {
    if (!payload || typeof payload !== 'object') return null;
    const version = payload._version;
    if (version === STORAGE_VERSION) return payload;
    if (version == null && !Array.isArray(payload)) {
      payload._version = STORAGE_VERSION;
      return payload;
    }
    return payload;
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(USE_CASES_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return migratePayload(parsed, USE_CASES_KEY);
    } catch (_) {
      return null;
    }
  }

  function mergeUseCases(defaults, stored) {
    const byId = new Map();
    (defaults.useCases || []).forEach(u => { if (u?.id) byId.set(u.id, { ...u }); });
    (stored?.useCases || []).forEach(u => {
      if (!u?.id) return;
      if (u.id.startsWith('user-') || !byId.has(u.id)) byId.set(u.id, { ...u });
      else byId.set(u.id, { ...byId.get(u.id), ...u }); // override default with stored edits
    });
    const defaultOrder = (defaults.useCases || []).map(u => u.id).filter(Boolean);
    const extra = [...byId.keys()].filter(id => !defaultOrder.includes(id));
    return [...defaultOrder.map(id => byId.get(id)).filter(Boolean), ...extra.map(id => byId.get(id)).filter(Boolean)];
  }

  function saveUseCases(useCases, activeUseCaseId) {
    try {
      const payload = {
        _version: STORAGE_VERSION,
        useCases: useCases || [],
        activeUseCaseId: activeUseCaseId || null
      };
      localStorage.setItem(USE_CASES_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('SiskelBot: failed to save use cases', e);
    }
  }

  global.SiskelBotUseCases = {
    STORAGE_VERSION,
    USE_CASES_KEY,
    DEFAULTS_FALLBACK,
    loadDefaults,
    loadFromStorage,
    mergeUseCases,
    saveUseCases
  };
})(typeof window !== 'undefined' ? window : globalThis);
