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
