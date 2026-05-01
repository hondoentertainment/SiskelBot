import { workspaceSearchText } from "./workspace-fs-tools.js";
import { search as knowledgeSearch } from "./knowledge-store.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_SNIPPETS = 20;

function extractKeywords(query) {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9_$.]/g, ""))
    .filter((t) => t.length > 2)
    .sort((a, b) => b.length - a.length);
}

function buildPrompt(query, snippets) {
  const snippetText = snippets
    .map((s) => `// ${s.file}:${s.line}\n${s.excerpt}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are a code expert. Answer questions about the codebase concisely. For each claim, cite the file and line number like [file.js:42].",
    },
    {
      role: "user",
      content: `Answer this question about the codebase: ${query}\n\nCode snippets:\n\n${snippetText}`,
    },
  ];
}

export async function searchCodebase(workspaceId, query, ctx, llmClient, opts = {}) {
  const maxFiles = opts.maxFiles ?? 10;
  const maxMatchesPerFile = opts.maxMatchesPerFile ?? 5;
  const model = opts.model ?? DEFAULT_MODEL;

  const keywords = extractKeywords(query);
  const primaryKeyword = keywords[0] || query;

  const [fsResult, kbResult] = await Promise.allSettled([
    workspaceSearchText(ctx, {
      query: primaryKeyword,
      maxMatches: Math.min(MAX_SNIPPETS, maxFiles * maxMatchesPerFile),
    }),
    knowledgeSearch({ query, workspace: workspaceId }),
  ]);

  const snippets = [];

  if (fsResult.status === "fulfilled" && fsResult.value?.ok && Array.isArray(fsResult.value.matches)) {
    for (const m of fsResult.value.matches) {
      if (snippets.length >= MAX_SNIPPETS) break;
      snippets.push({ file: m.file, line: m.line, excerpt: m.excerpt });
    }
  }

  if (kbResult.status === "fulfilled" && Array.isArray(kbResult.value?.snippets)) {
    for (const s of kbResult.value.snippets) {
      if (snippets.length >= MAX_SNIPPETS) break;
      const file = s.metadata?.file || s.id || "knowledge-base";
      const line = s.metadata?.line || 1;
      const excerpt = typeof s.snippet === "string" ? s.snippet.slice(0, 240) : String(s.snippet || "");
      if (excerpt) snippets.push({ file, line, excerpt });
    }
  }

  const citations = snippets.map((s) => ({ file: s.file, line: s.line, excerpt: s.excerpt }));

  if (typeof llmClient !== "function") {
    return { query, answer: null, citations, snippetsUsed: snippets.length };
  }

  const messages = buildPrompt(query, snippets);
  let answer = null;
  try {
    const response = await llmClient({ model, messages });
    answer =
      response?.choices?.[0]?.message?.content ??
      response?.content ??
      response?.answer ??
      String(response ?? "");
  } catch {
    answer = null;
  }

  return { query, answer, citations, snippetsUsed: snippets.length };
}

export async function findDefinition(workspaceId, symbol, ctx) {
  const patterns = [symbol];
  const defPatterns = [
    `function ${symbol}`,
    `class ${symbol}`,
    `const ${symbol}`,
    `let ${symbol}`,
    `var ${symbol}`,
    `async function ${symbol}`,
    `export function ${symbol}`,
    `export async function ${symbol}`,
    `export class ${symbol}`,
    `export const ${symbol}`,
  ];

  const definitions = [];

  for (const pat of [...patterns, ...defPatterns]) {
    const result = await workspaceSearchText(ctx, { query: pat, maxMatches: 20 });
    if (!result?.ok || !Array.isArray(result.matches)) continue;
    for (const m of result.matches) {
      const excerpt = m.excerpt || "";
      const isDefinition = defPatterns.some((dp) => excerpt.includes(dp.trim()));
      if (isDefinition || pat === symbol) {
        const alreadyAdded = definitions.some((d) => d.file === m.file && d.line === m.line);
        if (!alreadyAdded) {
          definitions.push({ file: m.file, line: m.line, context: excerpt });
        }
      }
    }
    if (definitions.length >= 20) break;
  }

  return { symbol, definitions };
}

export async function findReferences(workspaceId, symbol, ctx) {
  const result = await workspaceSearchText(ctx, { query: symbol, maxMatches: 80 });
  const references = [];

  if (result?.ok && Array.isArray(result.matches)) {
    for (const m of result.matches) {
      references.push({ file: m.file, line: m.line, context: m.excerpt });
    }
  }

  return { symbol, references };
}
