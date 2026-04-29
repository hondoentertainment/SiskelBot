import { join } from "path";
import { readJsonPath, getDataDir } from "./json-path-store.js";
import { list as listKnowledge } from "./knowledge-store.js";
import { list as listStorage } from "./storage.js";

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d[ \-]*?){13,19}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
const API_KEY_RE = /[A-Za-z0-9_\-]{32,}/g;
const NAME_CONTEXT_RE = /(?:name|full[ _]name|username)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;

function luhn(raw) {
  const digits = raw.replace(/[\s\-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactValue(type, value) {
  if (type === "email") {
    const at = value.indexOf("@");
    return at > 1 ? value[0] + "***" + value.slice(at) : "***@***";
  }
  if (type === "credit_card") return "*".repeat(value.replace(/[\s\-]/g, "").length - 4) + value.slice(-4);
  if (type === "ssn") return "***-**-" + value.slice(-4);
  if (type === "api_key") return value.slice(0, 4) + "..." + value.slice(-4);
  return "[REDACTED]";
}

const PATTERNS = [
  { type: "email", re: EMAIL_RE, severity: "high" },
  { type: "ssn", re: SSN_RE, severity: "high" },
  { type: "credit_card", re: CC_RE, severity: "high", validate: luhn },
  { type: "phone", re: PHONE_RE, severity: "medium" },
  { type: "ipv4", re: IPV4_RE, severity: "low" },
  { type: "ipv6", re: IPV6_RE, severity: "low" },
  { type: "api_key", re: API_KEY_RE, severity: "high" },
  { type: "name", re: NAME_CONTEXT_RE, severity: "low", captureGroup: 1 },
];

export function scanForPii(text) {
  if (!text || typeof text !== "string") return { hasPii: false, findings: [] };

  const findings = [];
  const seen = new Set();

  for (const { type, re, severity, validate, captureGroup } of PATTERNS) {
    const localRe = new RegExp(re.source, re.flags.replace("g", "") + "g");
    let match;
    while ((match = localRe.exec(text)) !== null) {
      const raw = captureGroup != null ? match[captureGroup] : match[0];
      if (!raw) continue;
      if (validate && !validate(raw)) continue;
      const position = captureGroup != null ? match.index + match[0].indexOf(raw) : match.index;
      const key = `${type}:${position}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        type,
        value: redactValue(type, raw),
        position,
        severity,
      });
    }
  }

  findings.sort((a, b) => a.position - b.position);
  return { hasPii: findings.length > 0, findings };
}

export function redactPii(text) {
  if (!text || typeof text !== "string") return text;

  const allMatches = [];

  for (const { type, re, validate, captureGroup } of PATTERNS) {
    const localRe = new RegExp(re.source, re.flags.replace("g", "") + "g");
    let match;
    while ((match = localRe.exec(text)) !== null) {
      const raw = captureGroup != null ? match[captureGroup] : match[0];
      if (!raw) continue;
      if (validate && !validate(raw)) continue;
      const start = captureGroup != null ? match.index + match[0].indexOf(raw) : match.index;
      const end = start + raw.length;
      allMatches.push({ start, end, type });
    }
  }

  if (allMatches.length === 0) return text;

  allMatches.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const m of allMatches) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end);
    } else {
      merged.push({ ...m });
    }
  }

  let result = "";
  let cursor = 0;
  for (const { start, end, type } of merged) {
    result += text.slice(cursor, start);
    result += `[REDACTED:${type}]`;
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

export async function scanWorkspaceForPii(workspaceId, { sampleSize = 100 } = {}) {
  const scannedAt = new Date().toISOString();
  const piiFindings = [];
  const summary = { high: 0, medium: 0, low: 0 };
  let documentsScanned = 0;

  const knowledgeDocs = await listKnowledge({ workspace: workspaceId }).catch(() => ({ items: [] }));
  const docItems = (knowledgeDocs?.items || []).slice(0, Math.floor(sampleSize / 2));

  for (const doc of docItems) {
    documentsScanned++;
    const textToScan = [doc.title, doc.content, doc.text].filter(Boolean).join(" ");
    if (!textToScan) continue;
    const { findings } = scanForPii(textToScan);
    if (findings.length === 0) continue;
    const byType = {};
    for (const f of findings) {
      byType[f.type] = (byType[f.type] || 0) + 1;
      summary[f.severity] = (summary[f.severity] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      piiFindings.push({ documentId: doc.id, type, count });
    }
  }

  const convPath = join(getDataDir(), "users", "anonymous", "workspaces", workspaceId, "conversations.json");
  const convData = await readJsonPath(convPath, { items: [] }).catch(() => ({ items: [] }));
  const convItems = (convData?.items || []).slice(0, Math.ceil(sampleSize / 2));

  for (const conv of convItems) {
    documentsScanned++;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const textToScan = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    if (!textToScan) continue;
    const { findings } = scanForPii(textToScan);
    if (findings.length === 0) continue;
    const byType = {};
    for (const f of findings) {
      byType[f.type] = (byType[f.type] || 0) + 1;
      summary[f.severity] = (summary[f.severity] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      piiFindings.push({ conversationId: conv.id, type, count });
    }
  }

  return {
    workspaceId,
    scannedAt,
    documentsScanned,
    piiFindings,
    summary,
  };
}
