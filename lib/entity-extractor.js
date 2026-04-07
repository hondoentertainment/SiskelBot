/**
 * Entity and relation extraction from text using pattern matching.
 * No external ML dependencies -- uses heuristics, regex, and a tech dictionary.
 */

const TECH_TERMS = new Set([
  "javascript", "typescript", "python", "java", "rust", "go", "ruby", "php", "swift",
  "kotlin", "scala", "haskell", "elixir", "clojure", "perl", "lua", "dart", "zig",
  "c", "c++", "c#", "objective-c", "assembly",
  "react", "vue", "angular", "svelte", "next.js", "nuxt", "remix", "gatsby", "astro",
  "node.js", "nodejs", "deno", "bun", "express", "fastify", "koa", "nest.js", "nestjs",
  "django", "flask", "fastapi", "spring", "rails", "laravel", "phoenix",
  "docker", "kubernetes", "k8s", "terraform", "ansible", "jenkins", "circleci",
  "github", "gitlab", "bitbucket", "jira", "linear", "slack", "discord", "vercel",
  "aws", "azure", "gcp", "google cloud", "heroku", "netlify", "cloudflare",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "sqlite", "dynamodb",
  "elasticsearch", "kafka", "rabbitmq", "nats", "graphql", "grpc", "rest",
  "webpack", "vite", "rollup", "esbuild", "parcel", "turbopack",
  "git", "npm", "yarn", "pnpm", "pip", "cargo", "maven", "gradle",
  "linux", "macos", "windows", "ubuntu", "debian", "centos",
  "openai", "anthropic", "claude", "gpt", "llm", "langchain", "ollama", "vllm",
  "html", "css", "sass", "tailwind", "bootstrap",
  "http", "https", "websocket", "tcp", "udp", "ssl", "tls",
  "json", "yaml", "toml", "xml", "csv", "protobuf",
  "oauth", "jwt", "saml", "oidc", "openid",
]);

const TECH_TERMS_LOWER = new Map();
for (const t of TECH_TERMS) {
  TECH_TERMS_LOWER.set(t.toLowerCase(), t);
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MENTION_REGEX = /@([a-zA-Z][a-zA-Z0-9_-]{1,38})/g;
const CAPITALIZED_PHRASE_REGEX = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;

/**
 * Split text into sentences (simple heuristic).
 */
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
}

/**
 * Extract entities from text using pattern matching.
 * @param {string} text - Document text
 * @param {string} [docId] - Source document ID
 * @returns {Array<{ name: string, type: string, confidence: number, positions: number[] }>}
 */
export function extractEntities(text, _docId) {
  if (typeof text !== "string" || !text.trim()) return [];

  const seen = new Map(); // name_lower -> entity

  function addEntity(name, type, confidence, position) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const existing = seen.get(key);
      existing.positions.push(position);
      existing.confidence = Math.min(1, Math.max(existing.confidence, confidence));
      return;
    }
    seen.set(key, { name, type, confidence, positions: [position] });
  }

  // Extract @mentions as persons
  let match;
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    addEntity(match[1], "person", 0.8, match.index);
  }

  // Extract email addresses as persons
  EMAIL_REGEX.lastIndex = 0;
  while ((match = EMAIL_REGEX.exec(text)) !== null) {
    const localPart = match[0].split("@")[0];
    addEntity(localPart, "person", 0.6, match.index);
  }

  // Extract URLs as technology/tool
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    try {
      const hostname = new URL(match[0]).hostname.replace(/^www\./, "");
      addEntity(hostname, "technology", 0.7, match.index);
    } catch {
      // invalid URL, skip
    }
  }

  // Extract known tech terms
  const textLower = text.toLowerCase();
  for (const [termLower, termOriginal] of TECH_TERMS_LOWER) {
    const idx = textLower.indexOf(termLower);
    if (idx !== -1) {
      // Verify word boundary
      const before = idx > 0 ? textLower[idx - 1] : " ";
      const after = idx + termLower.length < textLower.length ? textLower[idx + termLower.length] : " ";
      if (/[\s,.:;!?(/-]/.test(before) || idx === 0) {
        if (/[\s,.:;!?)/-]/.test(after) || idx + termLower.length === textLower.length) {
          addEntity(termOriginal, "technology", 0.9, idx);
        }
      }
    }
  }

  // Extract capitalized phrases as potential proper nouns
  CAPITALIZED_PHRASE_REGEX.lastIndex = 0;
  while ((match = CAPITALIZED_PHRASE_REGEX.exec(text)) !== null) {
    const phrase = match[1];
    // Skip if it's a sentence start (after period or at position 0)
    const beforeIdx = match.index - 2;
    if (match.index === 0) continue;
    if (beforeIdx >= 0 && text[beforeIdx] === ".") continue;

    const phraseLower = phrase.toLowerCase();
    // Skip if already captured as tech term
    if (TECH_TERMS_LOWER.has(phraseLower)) continue;
    // Skip common words
    if (isCommonWord(phraseLower)) continue;

    // Classify: multi-word capitalized -> likely organization or person
    const words = phrase.split(/\s+/);
    let type = "other";
    if (words.length >= 2) {
      type = words.length <= 3 ? "person" : "organization";
    }
    addEntity(phrase, type, 0.5, match.index);
  }

  return [...seen.values()];
}

const COMMON_WORDS = new Set([
  "the", "this", "that", "these", "those", "here", "there",
  "when", "where", "which", "what", "who", "how", "why",
  "also", "just", "only", "very", "much", "many", "some",
  "note", "example", "section", "chapter", "table", "figure",
  "however", "therefore", "furthermore", "moreover", "although",
  "first", "second", "third", "last", "next", "previous",
  "new", "old", "other", "another", "each", "every",
  "most", "more", "less", "few", "all", "any",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);

function isCommonWord(word) {
  return COMMON_WORDS.has(word.toLowerCase());
}

/**
 * Relation-extraction patterns.
 */
const RELATION_PATTERNS = [
  { regex: /(\S+)\s+uses?\s+(\S+)/gi, type: "uses" },
  { regex: /(\S+)\s+depends?\s+on\s+(\S+)/gi, type: "depends_on" },
  { regex: /(\S+)\s+is\s+part\s+of\s+(\S+)/gi, type: "part_of" },
  { regex: /(\S+)\s+(?:was\s+)?created\s+by\s+(\S+)/gi, type: "created_by", swap: true },
  { regex: /(\S+)\s+(?:is\s+)?built\s+(?:with|on|using)\s+(\S+)/gi, type: "uses" },
  { regex: /(\S+)\s+requires?\s+(\S+)/gi, type: "depends_on" },
  { regex: /(\S+)\s+integrates?\s+(?:with\s+)?(\S+)/gi, type: "related_to" },
];

/**
 * Extract relations between entities found in text.
 * Uses co-occurrence within sentences and explicit relation patterns.
 * @param {string} text
 * @param {Array<{ name: string, type: string }>} entities - Previously extracted entities
 * @returns {Array<{ from: string, to: string, type: string, evidence: string }>}
 */
export function extractRelations(text, entities) {
  if (typeof text !== "string" || !text.trim() || !Array.isArray(entities) || entities.length < 2) {
    return [];
  }

  const relations = [];
  const seen = new Set();

  function addRelation(from, to, type, evidence) {
    const key = `${from}|${to}|${type}`;
    const reverseKey = `${to}|${from}|${type}`;
    if (seen.has(key) || seen.has(reverseKey)) return;
    seen.add(key);
    relations.push({ from, to, type, evidence });
  }

  const entityNames = entities.map((e) => e.name);
  const entityNamesLower = entityNames.map((n) => n.toLowerCase());

  // Pattern-based extraction
  for (const pattern of RELATION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const word1 = match[1].toLowerCase().replace(/[^a-z0-9]/g, "");
      const word2 = match[2].toLowerCase().replace(/[^a-z0-9]/g, "");

      const idx1 = entityNamesLower.findIndex((n) => n.replace(/[^a-z0-9]/g, "").includes(word1) || word1.includes(n.replace(/[^a-z0-9]/g, "")));
      const idx2 = entityNamesLower.findIndex((n) => n.replace(/[^a-z0-9]/g, "").includes(word2) || word2.includes(n.replace(/[^a-z0-9]/g, "")));

      if (idx1 !== -1 && idx2 !== -1 && idx1 !== idx2) {
        const from = pattern.swap ? entityNames[idx2] : entityNames[idx1];
        const to = pattern.swap ? entityNames[idx1] : entityNames[idx2];
        addRelation(from, to, pattern.type, match[0].trim());
      }
    }
  }

  // Co-occurrence within same sentence -> related_to
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    const sentLower = sentence.toLowerCase();
    const present = [];
    for (let i = 0; i < entityNamesLower.length; i++) {
      if (sentLower.includes(entityNamesLower[i])) {
        present.push(i);
      }
    }
    // Connect co-occurring entities (limit pairs to avoid explosion)
    for (let i = 0; i < present.length && i < 5; i++) {
      for (let j = i + 1; j < present.length && j < 5; j++) {
        addRelation(
          entityNames[present[i]],
          entityNames[present[j]],
          "related_to",
          sentence.slice(0, 120),
        );
      }
    }
  }

  return relations;
}
