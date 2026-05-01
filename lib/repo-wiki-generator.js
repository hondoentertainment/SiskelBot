/**
 * Repo wiki generator — auto-generates a structured Markdown wiki for a workspace
 * by scanning its filesystem and synthesizing content via LLM.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { workspaceListDir, workspaceReadFile, workspaceSearchText } from "./workspace-fs-tools.js";

const STORE_VERSION = 1;
const LLM_PROMPT_MAX_CHARS = 30_000;
const MAX_FILES_PER_CATEGORY = 20;

function storePath(workspaceId) {
  const safe = String(workspaceId || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
  return join(getDataDir(), "repo-wiki", `${safe}.json`);
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && raw._version === STORE_VERSION) return raw;
  return { _version: STORE_VERSION, wiki: null };
}

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "page";
}

const CATEGORY_CONFIGS = [
  {
    category: "overview",
    title: "Project Overview",
    filePatterns: ["README", "package.json", ".env.example", "CLAUDE.md"],
    prompt: "Write a concise project overview in Markdown covering: what this project does, key technologies used, and its main value proposition. Use the provided files as context.",
  },
  {
    category: "architecture",
    title: "Architecture",
    filePatterns: ["server.js", "index.js", "app.js", "main.js"],
    prompt: "Write an architecture overview in Markdown. Describe the main components, how they interact, and the overall system design. Include a Mermaid flowchart diagram showing the main components and their relationships. Use ```mermaid blocks.",
  },
  {
    category: "modules",
    title: "Module Reference",
    filePatterns: [],
    searchQuery: "export",
    prompt: "Write a Markdown module reference listing the main modules/files, what each exports, and its purpose. Group related modules.",
  },
  {
    category: "api",
    title: "API Reference",
    filePatterns: ["routes/"],
    searchQuery: "router.get\|app.get\|router.post",
    prompt: "Write a Markdown API reference listing the main API endpoints grouped by resource. For each endpoint show: method, path, description, and key parameters.",
  },
  {
    category: "setup",
    title: "Setup & Configuration",
    filePatterns: [".env.example", "docker-compose.yml", "Dockerfile", "package.json"],
    prompt: "Write a Markdown setup guide covering: installation steps, environment variables, configuration options, and how to run the project. Be practical and concise.",
  },
];

async function gatherFileContent(ctx, patterns, searchQuery, workspaceId) {
  const snippets = [];
  const seen = new Set();

  for (const pattern of patterns) {
    if (seen.size >= MAX_FILES_PER_CATEGORY) break;
    try {
      const result = await workspaceReadFile(ctx, pattern);
      if (result.ok && !seen.has(pattern)) {
        seen.add(pattern);
        snippets.push(`// ${pattern}\n${result.content.slice(0, 4000)}`);
      }
    } catch {
      // file might not exist
    }
  }

  if (searchQuery && seen.size < MAX_FILES_PER_CATEGORY) {
    const queries = searchQuery.split("\\|");
    for (const q of queries) {
      if (seen.size >= MAX_FILES_PER_CATEGORY) break;
      try {
        const sr = await workspaceSearchText(ctx, { query: q.trim(), maxMatches: 10 });
        if (sr.ok && sr.matches) {
          for (const m of sr.matches) {
            if (seen.size >= MAX_FILES_PER_CATEGORY) break;
            if (!seen.has(m.file)) {
              seen.add(m.file);
              const fr = await workspaceReadFile(ctx, m.file);
              if (fr.ok) snippets.push(`// ${m.file}\n${fr.content.slice(0, 2000)}`);
            }
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  const combined = snippets.join("\n\n---\n\n");
  return combined.length > LLM_PROMPT_MAX_CHARS ? combined.slice(0, LLM_PROMPT_MAX_CHARS) : combined;
}

async function generatePage(cat, ctx, llmClient, model) {
  const content = await gatherFileContent(ctx, cat.filePatterns || [], cat.searchQuery || "", null);

  if (!llmClient || !content.trim()) {
    return {
      pageId: randomUUID(),
      title: cat.title,
      slug: slugify(cat.title),
      content: `# ${cat.title}\n\n_Wiki generation requires an LLM client. Configure one to auto-generate this page._`,
      category: cat.category,
      sourceFiles: [],
      mermaidDiagram: null,
    };
  }

  const messages = [
    {
      role: "system",
      content: "You are a technical documentation writer. Write clear, concise Markdown documentation.",
    },
    {
      role: "user",
      content: `${cat.prompt}\n\n## Source files\n\n${content}`,
    },
  ];

  let pageContent = `# ${cat.title}\n\n_Generation failed_`;
  try {
    const res = await llmClient({ model: model || "default", messages });
    pageContent = res?.content || res?.choices?.[0]?.message?.content || pageContent;
  } catch {
    // keep placeholder
  }

  const mermaidMatch = pageContent.match(/```mermaid\n([\s\S]+?)```/);

  return {
    pageId: randomUUID(),
    title: cat.title,
    slug: slugify(cat.title),
    content: pageContent,
    category: cat.category,
    sourceFiles: [],
    mermaidDiagram: mermaidMatch ? mermaidMatch[1] : null,
  };
}

export async function generateWiki(workspaceId, ctx, llmClient, opts = {}) {
  const model = opts.model;
  const wikiId = randomUUID();
  const now = Date.now();

  const initial = {
    wikiId,
    workspaceId,
    generatedAt: now,
    pages: [],
    indexedFiles: 0,
    status: "generating",
  };

  await withPathLock(storePath(workspaceId), async () => {
    const store = normalizeStore(await readJsonPath(storePath(workspaceId), {}));
    store.wiki = initial;
    await writeJsonPath(storePath(workspaceId), store);
  });

  try {
    const pages = [];
    for (const cat of CATEGORY_CONFIGS) {
      const page = await generatePage(cat, ctx, llmClient, model);
      pages.push(page);
    }

    let indexedFiles = 0;
    try {
      const listing = await workspaceListDir(ctx, ".");
      indexedFiles = listing.total || (listing.entries || []).length;
    } catch {
      // best-effort
    }

    const wiki = {
      wikiId,
      workspaceId,
      generatedAt: Date.now(),
      pages,
      indexedFiles,
      status: "ready",
    };

    await withPathLock(storePath(workspaceId), async () => {
      const store = normalizeStore(await readJsonPath(storePath(workspaceId), {}));
      store.wiki = wiki;
      await writeJsonPath(storePath(workspaceId), store);
    });

    return wiki;
  } catch (err) {
    await withPathLock(storePath(workspaceId), async () => {
      const store = normalizeStore(await readJsonPath(storePath(workspaceId), {}));
      if (store.wiki) store.wiki.status = "failed";
      await writeJsonPath(storePath(workspaceId), store);
    });
    throw err;
  }
}

export async function getWiki(workspaceId) {
  const store = normalizeStore(await readJsonPath(storePath(workspaceId), {}));
  return store.wiki || null;
}

export async function getWikiPage(workspaceId, slug) {
  const wiki = await getWiki(workspaceId);
  if (!wiki) return null;
  return (wiki.pages || []).find((p) => p.slug === slug) || null;
}

export async function listWikiPages(workspaceId) {
  const wiki = await getWiki(workspaceId);
  if (!wiki) return [];
  return (wiki.pages || []).map(({ pageId, title, slug, category, mermaidDiagram }) => ({
    pageId, title, slug, category, hasDiagram: !!mermaidDiagram,
  }));
}

export async function invalidateWiki(workspaceId) {
  return withPathLock(storePath(workspaceId), async () => {
    const store = normalizeStore(await readJsonPath(storePath(workspaceId), {}));
    if (store.wiki) {
      store.wiki.status = "pending";
    } else {
      store.wiki = { wikiId: randomUUID(), workspaceId, generatedAt: 0, pages: [], indexedFiles: 0, status: "pending" };
    }
    await writeJsonPath(storePath(workspaceId), store);
    return store.wiki;
  });
}
