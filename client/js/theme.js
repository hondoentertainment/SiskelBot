/**
 * Theme toggle module for SiskelBot.
 * Applies dark/light themes via CSS custom properties on :root[data-theme].
 */

const STORAGE_KEY = 'siskelbot_theme';

const THEMES = {
  dark: {
    '--bg-primary': '#0f172a',
    '--bg-secondary': '#1e293b',
    '--bg-tertiary': '#334155',
    '--text-primary': '#e2e8f0',
    '--text-secondary': '#94a3b8',
    '--text-muted': '#64748b',
    '--accent': '#2563eb',
    '--accent-hover': '#1d4ed8',
    '--success': '#34d399',
    '--warning': '#fbbf24',
    '--error': '#f87171',
    '--border': '#334155'
  },
  light: {
    '--bg-primary': '#ffffff',
    '--bg-secondary': '#f8fafc',
    '--bg-tertiary': '#e2e8f0',
    '--text-primary': '#1e293b',
    '--text-secondary': '#475569',
    '--text-muted': '#94a3b8',
    '--accent': '#2563eb',
    '--accent-hover': '#1d4ed8',
    '--success': '#059669',
    '--warning': '#d97706',
    '--error': '#dc2626',
    '--border': '#e2e8f0'
  }
};

function getSystemPreference() {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function applyTheme(name) {
  const vars = THEMES[name];
  if (!vars) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', name);
  for (const [prop, value] of Object.entries(vars)) {
    root.style.setProperty(prop, value);
  }
}

export function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const theme = (saved === 'light' || saved === 'dark') ? saved : getSystemPreference();
  applyTheme(theme);

  // Listen for OS-level theme changes when no explicit preference is saved
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        applyTheme(e.matches ? 'light' : 'dark');
      }
    });
  }

  return theme;
}

export function toggleTheme() {
  const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
  return next;
}

// Expose on window for non-module consumers
if (typeof window !== 'undefined') {
  window.SiskelTheme = { initTheme, toggleTheme, getCurrentTheme };
}
