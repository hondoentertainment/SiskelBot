/**
 * Phase 46.4: Group rule evaluation engine.
 *
 * Pure helpers for matching external identity provider group names against
 * SiskelBot group-sync rules and resolving role conflicts when multiple rules
 * apply to the same workspace.
 *
 * Pattern matching supports three flavors, auto-detected from the rule shape:
 *   - Literal:  { groupPattern: "engineering" }                  exact match
 *   - Regex:    { groupPattern: "/^eng-.+$/i" } or { groupPattern: "...", patternType: "regex" }
 *   - Glob:     { groupPattern: "eng-*" }    (contains * or ?)
 *
 * Role conflict resolution uses a precedence ordering where the highest role
 * always wins so the principle of least surprise (more access, never less)
 * is preserved when rules overlap.
 */

const ROLE_PRECEDENCE = ["viewer", "member", "admin", "owner"];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob) {
  // Convert simple glob (* and ?) to anchored regex
  let out = "^";
  for (const ch of String(glob)) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += escapeRegex(ch);
  }
  out += "$";
  return new RegExp(out);
}

function parseInlineRegex(pattern) {
  // /pattern/flags syntax
  if (typeof pattern !== "string") return null;
  if (pattern.length < 2 || pattern[0] !== "/") return null;
  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const body = pattern.slice(1, lastSlash);
  const flags = pattern.slice(lastSlash + 1);
  if (!/^[gimsuy]*$/.test(flags)) return null;
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * Detect the kind of pattern given a string and an optional explicit hint.
 * @param {string} pattern
 * @param {"literal"|"regex"|"glob"} [hint]
 * @returns {"literal"|"regex"|"glob"}
 */
export function detectPatternType(pattern, hint) {
  if (hint === "literal" || hint === "regex" || hint === "glob") return hint;
  if (typeof pattern !== "string") return "literal";
  if (parseInlineRegex(pattern)) return "regex";
  if (pattern.includes("*") || pattern.includes("?")) return "glob";
  return "literal";
}

/**
 * Test whether a group name matches a pattern.
 * @param {string} groupName
 * @param {string} pattern
 * @param {"literal"|"regex"|"glob"} [patternType] - optional override
 * @returns {boolean}
 */
export function matchGroupPattern(groupName, pattern, patternType) {
  if (typeof groupName !== "string" || groupName.length === 0) return false;
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  const type = detectPatternType(pattern, patternType);
  if (type === "literal") {
    return groupName === pattern;
  }
  if (type === "regex") {
    const re = parseInlineRegex(pattern) || (() => {
      try { return new RegExp(pattern); } catch { return null; }
    })();
    if (!re) return false;
    return re.test(groupName);
  }
  if (type === "glob") {
    return globToRegex(pattern).test(groupName);
  }
  return false;
}

/**
 * Evaluate a list of rules against a user's external groups.
 * Returns the rules that match, paired with the group name that matched first.
 * @param {string[]} userGroups
 * @param {Array<object>} rules
 * @returns {Array<{ rule: object, matchedGroup: string }>}
 */
export function evaluateRules(userGroups, rules) {
  if (!Array.isArray(userGroups) || !Array.isArray(rules)) return [];
  const out = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const pattern = rule.groupPattern;
    if (typeof pattern !== "string") continue;
    let matchedGroup = null;
    for (const g of userGroups) {
      if (matchGroupPattern(g, pattern, rule.patternType)) {
        matchedGroup = g;
        break;
      }
    }
    if (matchedGroup) {
      out.push({ rule, matchedGroup });
    }
  }
  return out;
}

/**
 * Resolve role conflicts. Given a list of role assignments (one or more
 * candidate roles for the same workspace), return the highest-precedence role.
 *
 * Accepts either: ["viewer", "admin"] or [{ role: "viewer" }, { role: "admin" }].
 * Unknown role names are ignored. Returns null if no recognized roles.
 *
 * @param {Array<string|{ role: string }>} roleAssignments
 * @returns {string|null}
 */
export function resolveRoleConflict(roleAssignments) {
  if (!Array.isArray(roleAssignments) || roleAssignments.length === 0) return null;
  let bestIdx = -1;
  for (const a of roleAssignments) {
    const role = typeof a === "string" ? a : a?.role;
    const idx = ROLE_PRECEDENCE.indexOf(role);
    if (idx > bestIdx) bestIdx = idx;
  }
  if (bestIdx < 0) return null;
  return ROLE_PRECEDENCE[bestIdx];
}

/**
 * Group a list of evaluated matches by target workspace and resolve a single
 * winning role per workspace via {@link resolveRoleConflict}. Useful when
 * applying sync results.
 * @param {Array<{ rule: object, matchedGroup: string }>} matches
 * @returns {Map<string, { role: string, ruleIds: string[], matchedGroups: string[] }>}
 */
export function reduceMatchesByWorkspace(matches) {
  const byWs = new Map();
  for (const m of matches) {
    const ws = m.rule?.targetWorkspace;
    if (!ws) continue;
    if (!byWs.has(ws)) {
      byWs.set(ws, { roles: [], ruleIds: [], matchedGroups: [] });
    }
    const bucket = byWs.get(ws);
    bucket.roles.push(m.rule.targetRole);
    if (m.rule.id) bucket.ruleIds.push(m.rule.id);
    bucket.matchedGroups.push(m.matchedGroup);
  }
  const out = new Map();
  for (const [ws, bucket] of byWs.entries()) {
    const role = resolveRoleConflict(bucket.roles) || "viewer";
    out.set(ws, { role, ruleIds: bucket.ruleIds, matchedGroups: bucket.matchedGroups });
  }
  return out;
}

export const ROLE_ORDER = ROLE_PRECEDENCE.slice();
