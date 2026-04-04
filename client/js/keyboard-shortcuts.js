/**
 * Keyboard shortcuts module for SiskelBot.
 * Registers global key bindings with platform-aware modifier keys.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const DEFAULT_SHORTCUTS = {
  'mod+k': { action: 'search', label: 'Search conversations', category: 'Navigation' },
  'mod+n': { action: 'newChat', label: 'New conversation', category: 'Navigation' },
  'mod+/': { action: 'showShortcuts', label: 'Show keyboard shortcuts', category: 'General' },
  'mod+,': { action: 'settings', label: 'Open settings', category: 'General' },
  'mod+shift+t': { action: 'toggleTheme', label: 'Toggle theme', category: 'General' },
  'escape': { action: 'closeModal', label: 'Close modal/panel', category: 'General' },
  'mod+enter': { action: 'send', label: 'Send message', category: 'Chat' }
};

function normalizeEvent(e) {
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  let key = e.key.toLowerCase();
  // Normalize special keys
  if (key === 'escape') key = 'escape';
  else if (key === 'enter') key = 'enter';
  else if (key === ',') key = ',';
  else if (key === '/') key = '/';

  parts.push(key);
  return parts.join('+');
}

let activeListener = null;

export function initKeyboardShortcuts(handlers) {
  if (activeListener) {
    document.removeEventListener('keydown', activeListener);
  }

  const shortcutMap = {};
  for (const [combo, entry] of Object.entries(DEFAULT_SHORTCUTS)) {
    if (handlers[combo]) {
      shortcutMap[combo] = handlers[combo];
    } else if (handlers[entry.action]) {
      shortcutMap[combo] = handlers[entry.action];
    }
  }
  // Also allow custom combos from handlers not in defaults
  for (const [combo, fn] of Object.entries(handlers)) {
    if (typeof fn === 'function' && !shortcutMap[combo]) {
      shortcutMap[combo] = fn;
    }
  }

  activeListener = (e) => {
    // Skip when user is typing in an input/textarea (except for mod combos and escape)
    const tag = e.target.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
    const normalized = normalizeEvent(e);

    if (isInput && !normalized.startsWith('mod+') && normalized !== 'escape') {
      return;
    }

    const handler = shortcutMap[normalized];
    if (handler) {
      e.preventDefault();
      handler(e);
    }
  };

  document.addEventListener('keydown', activeListener);
}

export function getShortcutMap() {
  return { ...DEFAULT_SHORTCUTS };
}

function modLabel() {
  return isMac ? '\u2318' : 'Ctrl';
}

function formatCombo(combo) {
  return combo
    .split('+')
    .map((part) => {
      if (part === 'mod') return modLabel();
      if (part === 'shift') return isMac ? '\u21E7' : 'Shift';
      if (part === 'alt') return isMac ? '\u2325' : 'Alt';
      if (part === 'enter') return isMac ? '\u21A9' : 'Enter';
      if (part === 'escape') return 'Esc';
      return part.toUpperCase();
    })
    .join(isMac ? '' : '+');
}

export function renderShortcutsPanel(containerEl) {
  const shortcuts = getShortcutMap();
  const grouped = {};
  for (const [combo, entry] of Object.entries(shortcuts)) {
    const cat = entry.category || 'General';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ combo, ...entry });
  }

  const panel = document.createElement('div');
  panel.className = 'shortcuts-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Keyboard shortcuts');
  panel.innerHTML = `
    <div class="shortcuts-backdrop"></div>
    <div class="shortcuts-content">
      <div class="shortcuts-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="shortcuts-close" aria-label="Close">&times;</button>
      </div>
      <div class="shortcuts-body">
        ${Object.entries(grouped)
          .map(
            ([cat, items]) => `
          <div class="shortcuts-category">
            <h3>${cat}</h3>
            ${items
              .map(
                (item) => `
              <div class="shortcut-row">
                <span class="shortcut-label">${item.label}</span>
                <kbd class="shortcut-key">${formatCombo(item.combo)}</kbd>
              </div>`
              )
              .join('')}
          </div>`
          )
          .join('')}
      </div>
    </div>
  `;

  // Style the panel inline so it works without external CSS
  const style = document.createElement('style');
  style.textContent = `
    .shortcuts-panel { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; }
    .shortcuts-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
    .shortcuts-content { position: relative; background: var(--bg-secondary, #1e293b); color: var(--text-primary, #e2e8f0); border-radius: 12px; padding: 24px; max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .shortcuts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .shortcuts-header h2 { margin: 0; font-size: 18px; }
    .shortcuts-close { background: none; border: none; color: var(--text-muted, #64748b); font-size: 24px; cursor: pointer; padding: 4px 8px; }
    .shortcuts-close:hover { color: var(--text-primary, #e2e8f0); }
    .shortcuts-category h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted, #64748b); margin: 16px 0 8px; }
    .shortcut-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; }
    .shortcut-label { font-size: 14px; }
    .shortcut-key { background: var(--bg-tertiary, #334155); border: 1px solid var(--border, #334155); border-radius: 6px; padding: 2px 8px; font-size: 13px; font-family: inherit; min-width: 24px; text-align: center; }
  `;
  panel.prepend(style);

  const close = () => panel.remove();
  panel.querySelector('.shortcuts-backdrop').addEventListener('click', close);
  panel.querySelector('.shortcuts-close').addEventListener('click', close);

  containerEl.appendChild(panel);
  return panel;
}

// Expose on window for non-module consumers
if (typeof window !== 'undefined') {
  window.SiskelKeyboard = { initKeyboardShortcuts, getShortcutMap, renderShortcutsPanel };
}
