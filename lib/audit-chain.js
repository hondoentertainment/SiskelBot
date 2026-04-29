import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

function auditLogPath() {
  return join(
    process.env.STORAGE_PATH || join(PROJECT_ROOT, "data"),
    "execution-audit.json"
  );
}

function chainHeadPath(workspaceId) {
  return join(getDataDir(), `audit-chain-head-${workspaceId}.json`);
}

export function computeEntryHash(entry, prevHash = "0000000000000000") {
  const payload = prevHash + JSON.stringify({
    event: entry.event,
    userId: entry.userId ?? null,
    workspaceId: entry.workspaceId ?? null,
    createdAt: entry.createdAt,
    metadata: entry.metadata ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function getChainHead(workspaceId) {
  const path = chainHeadPath(workspaceId);
  const data = await readJsonPath(path, null);
  if (!data || typeof data.hash !== "string") return null;
  return data;
}

export async function writeChainedEntry(workspaceId, entry) {
  const headPath = chainHeadPath(workspaceId);
  const logPath = auditLogPath();

  let chainedEntry;

  await withPathLock(headPath, async () => {
    const head = await getChainHead(workspaceId);
    const prevHash = head ? head.hash : "0000000000000000";
    const sequence = head ? head.sequence + 1 : 1;

    const hash = computeEntryHash(entry, prevHash);

    chainedEntry = {
      ...entry,
      hash,
      prevHash,
      sequence,
    };

    await withPathLock(logPath, async () => {
      const loaded = await readJsonPath(logPath, []);
      const entries = Array.isArray(loaded) ? loaded : [];
      entries.push(chainedEntry);
      await writeJsonPath(logPath, entries);
    });

    await writeJsonPath(headPath, {
      hash,
      sequence,
      lastEntryAt: entry.createdAt || new Date().toISOString(),
    });
  });

  return chainedEntry;
}

export async function verifyChain(workspaceId, { limit = 100 } = {}) {
  const logPath = auditLogPath();
  const loaded = await readJsonPath(logPath, []);
  const entries = Array.isArray(loaded) ? loaded : [];

  const wsEntries = entries
    .filter((e) => e.workspaceId === workspaceId && typeof e.sequence === "number")
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-limit);

  let valid = true;
  let firstBadSequence = null;

  for (const entry of wsEntries) {
    const expected = computeEntryHash(entry, entry.prevHash ?? "0000000000000000");
    if (expected !== entry.hash) {
      valid = false;
      if (firstBadSequence === null) firstBadSequence = entry.sequence;
    }
  }

  return {
    workspaceId,
    entriesChecked: wsEntries.length,
    valid,
    firstBadSequence,
    verifiedAt: new Date().toISOString(),
  };
}
