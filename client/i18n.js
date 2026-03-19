/**
 * Phase 31: Internationalization (i18n) for SiskelBot
 * Load locale on init, t(key) returns translated string or key fallback.
 * Fallback chain: requested locale -> en -> key
 * RTL: dir="rtl" on html when locale is RTL (e.g. ar)
 */
(function () {
  const LOCALE_STORAGE_KEY = 'siskelbot-locale';
  const RTL_LOCALES = ['ar'];
  const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de'];

  let messages = {};
  let currentLocale = 'en';

  function getNested(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * Translate a key. Returns translated string or key as fallback.
   * @param {string} key - Dot-notation key (e.g. "header.newChat")
   * @returns {string}
   */
  function t(key) {
    const v = getNested(messages, key);
    if (typeof v === 'string') return v;
    return key;
  }

  /**
   * Translate with interpolation. Use {{name}} placeholders.
   * @param {string} key
   * @param {Record<string,string>} params
   * @returns {string}
   */
  function tInterp(key, params) {
    let s = t(key);
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        s = s.replace(new RegExp('{{' + k + '}}', 'g'), String(v));
      }
    }
    return s;
  }

  function detectLocale() {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
    } catch (_) {}
    const nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    const lang = nav.split('-')[0];
    if (SUPPORTED_LOCALES.includes(lang)) return lang;
    if (lang === 'en') return 'en';
    return 'en';
  }

  function isRTL(locale) {
    return RTL_LOCALES.includes((locale || '').toLowerCase());
  }

  function applyDir() {
    const html = document.documentElement;
    if (isRTL(currentLocale)) {
      html.setAttribute('dir', 'rtl');
    } else {
      html.removeAttribute('dir');
    }
  }

  function deepMerge(base, overlay) {
    const out = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      if (v != null && typeof v === 'object' && !Array.isArray(v) &&
          base[k] != null && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async function loadLocale(lang) {
    let base = {};
    try {
      const enRes = await fetch('/locales/en.json');
      if (enRes.ok) base = await enRes.json();
    } catch (_) {}

    if (lang !== 'en') {
      try {
        const res = await fetch('/locales/' + lang + '.json');
        if (res.ok) {
          const data = await res.json();
          messages = deepMerge(base, data);
          currentLocale = lang;
          applyDir();
          return true;
        }
      } catch (_) {}
    }

    messages = base;
    currentLocale = 'en';
    applyDir();
    return true;
  }

  async function init() {
    currentLocale = detectLocale();
    await loadLocale(currentLocale);
    applyTranslations();
    return currentLocale;
  }

  function applyTranslations() {
    const localeSelect = document.getElementById('locale-select');
    if (localeSelect) localeSelect.value = currentLocale;

    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr');
      const val = t(key);
      if (attr) {
        el.setAttribute(attr, val);
      } else {
        el.textContent = val;
      }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });
  }

  function setLocale(lang) {
    if (!SUPPORTED_LOCALES.includes(lang)) return Promise.resolve(false);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, lang);
    } catch (_) {}
    return loadLocale(lang).then(() => {
      applyTranslations();
      return true;
    });
  }

  window.SiskelI18n = {
    t,
    tInterp,
    init,
    setLocale,
    getLocale: () => currentLocale,
    getSupportedLocales: () => [...SUPPORTED_LOCALES],
    applyTranslations,
    isRTL,
  };
})();
