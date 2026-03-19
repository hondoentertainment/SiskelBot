/**
 * SiskelBot templates and profiles system.
 * Loads defaults from templates.defaults.json and merges with user-created localStorage data.
 */
(function (global) {
  const STORAGE_VERSION = 1;
  const TEMPLATES_KEY = 'siskelbot-templates';
  const PROFILES_KEY = 'siskelbot-profiles';

  const DEFAULTS_FALLBACK = {
    templates: [
      { id: 'coding', name: 'Coding', systemPrompt: 'You are a helpful coding assistant. Provide clear code examples, explain your reasoning, and follow best practices.', model: null },
      { id: 'deployment', name: 'Deployment', systemPrompt: 'You are a DevOps and deployment assistant. Help with CI/CD, containers, cloud services, and infrastructure as code.', model: null },
      { id: 'research', name: 'Research', systemPrompt: 'You are a research assistant. Be thorough, cite sources when relevant, and provide structured analysis.', model: null },
      { id: 'content', name: 'Content', systemPrompt: 'You are a content and copywriting assistant. Help with drafting, editing, and tone adjustment.', model: null },
      { id: 'ops', name: 'Ops', systemPrompt: 'You are an ops assistant. Help with troubleshooting, monitoring, runbooks, and quick operational tasks.', model: null }
    ],
    profiles: [
      { id: 'profile-coding', name: 'Coding', templateId: 'coding', model: '', systemPrompt: 'You are a helpful coding assistant. Provide clear code examples, explain your reasoning, and follow best practices.' },
      { id: 'profile-quick-ops', name: 'Quick ops', templateId: 'ops', model: '', systemPrompt: 'You are an ops assistant. Be concise. Help with troubleshooting, monitoring, runbooks, and quick operational tasks.' },
      { id: 'profile-detailed-research', name: 'Detailed research', templateId: 'research', model: '', systemPrompt: 'You are a research assistant. Be thorough, cite sources when relevant, and provide structured analysis.' }
    ]
  };

  async function loadDefaults() {
    try {
      const r = await fetch('/templates.defaults.json');
      if (r.ok) {
        const data = await r.json();
        if (data?.templates?.length && data?.profiles?.length) return data;
      }
    } catch (_) {}
    return DEFAULTS_FALLBACK;
  }

  function migratePayload(payload, key) {
    if (!payload || typeof payload !== 'object') return null;
    const version = payload._version;
    if (version === STORAGE_VERSION) return payload;
    if (version == null) {
      if (Array.isArray(payload)) return null;
      payload._version = STORAGE_VERSION;
      return payload;
    }
    return payload;
  }

  function loadTemplatesFromStorage() {
    try {
      const raw = localStorage.getItem(TEMPLATES_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return migratePayload(parsed, TEMPLATES_KEY);
    } catch (_) {
      return null;
    }
  }

  function loadProfilesFromStorage() {
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return migratePayload(parsed, PROFILES_KEY);
    } catch (_) {
      return null;
    }
  }

  function mergeTemplates(defaults, stored) {
    const defaultById = Object.fromEntries((defaults.templates || []).map(t => [t.id, t]));
    const userTemplates = (stored?.templates || []).filter(t => t?.id?.startsWith('user-'));
    return [...(defaults.templates || []), ...userTemplates];
  }

  function mergeProfiles(defaults, stored) {
    const defaultIds = new Set((defaults.profiles || []).map(p => p.id));
    const userProfiles = (stored?.profiles || []).filter(p => p?.id && !defaultIds.has(p.id));
    return [...(defaults.profiles || []), ...userProfiles];
  }

  function saveTemplates(templates, userOnly) {
    const payload = { _version: STORAGE_VERSION };
    if (userOnly) {
      payload.templates = templates.filter(t => t?.id?.startsWith('user-'));
    } else {
      payload.templates = templates;
    }
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('SiskelBot: failed to save templates', e);
    }
  }

  function saveProfiles(profiles, activeProfileId) {
    try {
      const payload = { _version: STORAGE_VERSION, profiles: profiles || [], activeProfileId: activeProfileId || null };
      localStorage.setItem(PROFILES_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('SiskelBot: failed to save profiles', e);
    }
  }

  global.SiskelBotTemplates = {
    STORAGE_VERSION,
    TEMPLATES_KEY,
    PROFILES_KEY,
    DEFAULTS_FALLBACK,
    loadDefaults,
    loadTemplatesFromStorage,
    loadProfilesFromStorage,
    mergeTemplates,
    mergeProfiles,
    saveTemplates,
    saveProfiles
  };
})(typeof window !== 'undefined' ? window : globalThis);
