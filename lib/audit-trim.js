/**
 * Phase 52: Audit log retention — max entries and optional age filter.
 */

/**
 * @param {Array<{timestamp?: string}>} entries
 * @param {number} maxEntries
 * @param {number|null} maxAgeDays - if set, drop entries older than this many days
 * @returns {Array}
 */
export function trimAuditEntries(entries, maxEntries, maxAgeDays) {
  let out = Array.isArray(entries) ? [...entries] : [];
  if (maxAgeDays != null && maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    out = out.filter((e) => {
      const t = e?.timestamp ? Date.parse(e.timestamp) : NaN;
      if (Number.isNaN(t)) return true;
      return t >= cutoff;
    });
  }
  const max = Math.max(1, Number(maxEntries) || 1000);
  if (out.length > max) {
    out = out.slice(-max);
  }
  return out;
}
