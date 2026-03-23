/**
 * Phase 72: Fixed-size text chunking with overlap for knowledge indexing.
 */

/**
 * @param {string} text
 * @param {number} maxChars - target max characters per chunk
 * @param {number} overlap - characters repeated between consecutive chunks
 * @returns {string[]}
 */
export function chunkPlainText(text, maxChars = 4000, overlap = 200) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return [];
  const max = Math.max(256, Math.min(32_000, maxChars));
  const ov = Math.max(0, Math.min(Math.floor(max / 2), overlap));
  if (t.length <= max) return [t];

  const chunks = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + max);
    if (end < t.length) {
      const slice = t.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf(" "));
      if (breakAt > max * 0.5) {
        end = start + breakAt + 1;
      }
    }
    const piece = t.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= t.length) break;
    start = Math.max(end - ov, start + 1);
  }
  return chunks;
}
