import { recordModerationBlock } from "./metrics.js";

const MODERATION_ENABLED = process.env.MODERATION_ENABLED !== "0";

const PATTERNS = {
  prompt_injection: [
    /ignore\s+(all\s+|previous\s+|above\s+)?instructions/i,
    /disregard\s+(all\s+|any\s+|prior\s+|your\s+)*instructions/i,
    /forget\s+(all\s+|your\s+|previous\s+|prior\s+)*instructions/i,
    /override\s+(safety|content|ethical)\s+(filter|policy|guideline)/i,
    /system:\s*override/i,
    /new\s+(system\s+|base\s+)?prompt/i,
    /\bDAN\b.*mode/i,
    /do\s+anything\s+now/i,
  ],
  jailbreak: [
    /jailbreak/i,
    /pretend\s+you\s+(are|have)/i,
    /you\s+are\s+now\s+(an?\s+)?(unrestricted|unfiltered|uncensored|evil|bad|rogue)/i,
    /act\s+as\s+(an?\s+)?(unrestricted|unfiltered|uncensored|evil|bad|rogue)/i,
    /enter\s+(developer|debug|admin|god|grandma)\s+mode/i,
    /bypass\s+(your\s+|all\s+|any\s+)?restrictions/i,
    /reveal\s+.*system\s+.*prompt/i,
    /no\s+restrictions?\s+mode/i,
  ],
  pii_extraction: [
    /\bssn\b|\bsocial\s+security\s+number\b/i,
    /extract\s+.{0,30}\b(password|credential|secret|api.?key|token)\b/i,
    /show\s+me\s+.{0,30}\b(password|credential|api.?key|token)\b/i,
    /list\s+(all\s+)?(user|customer|employee)\s+(email|phone|address|data|info)/i,
    /dump\s+(all\s+)?(user|customer|database|table)/i,
    /\bGDPR\b.*bypass/i,
  ],
  harmful_content: [
    /\b(make|build|create|synthesize|produce)\s+(a\s+)?(bomb|explosive|bioweapon|chemical\s+weapon|nerve\s+agent|meth(?:amphetamine)?|fentanyl)/i,
    /how\s+to\s+(make|build|create|synthesize)\s+(a\s+)?(bomb|explosive|poison|drug|meth|weapon)/i,
    /instructions?\s+(for|on|to)\s+(make|build|create|synthesize)\s+(a\s+)?(bomb|explosive|weapon|poison)/i,
    /\bcsam\b|\bchild\s+(porn|pornography|sexual\s+abuse\s+material)\b/i,
    /\b(self.?harm|suicide)\s+(method|instruction|how.?to|guide|step)/i,
    /\b(kill|murder|assassinate)\s+(myself|yourself|someone|a\s+person)\b/i,
    /detailed\s+instructions?\s+(to|for|on)\s+(harm|hurt|attack|kill)/i,
    /\bminor.{0,20}(sexual|explicit|nude|naked)\b/i,
  ],
};

function matchPatterns(text) {
  for (const [category, patterns] of Object.entries(PATTERNS)) {
    for (const re of patterns) {
      if (re.test(text)) {
        return { allowed: false, reason: `Content policy violation: ${category}`, category };
      }
    }
  }
  return { allowed: true, reason: null, category: null };
}

async function callModerationApi(text) {
  const url = process.env.MODERATION_API_URL;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) throw new Error(`Moderation API error: ${resp.status}`);
  const data = await resp.json();
  if (!data.flagged) return { allowed: true, reason: null, category: null };
  const category = data.categories ? Object.keys(data.categories).find((k) => data.categories[k]) || "harmful_content" : "harmful_content";
  return { allowed: false, reason: `Content policy violation: ${category}`, category };
}

export async function checkInput(text, options = {}) {
  if (!MODERATION_ENABLED) return { allowed: true, reason: null, category: null };
  if (typeof text !== "string" || !text.trim()) return { allowed: true, reason: null, category: null };

  let result;
  if (process.env.MODERATION_API_URL) {
    result = await callModerationApi(text);
  } else {
    result = matchPatterns(text);
  }

  if (!result.allowed) {
    recordModerationBlock(result.category, "input");
  }
  return result;
}

export async function checkOutput(text, options = {}) {
  if (!MODERATION_ENABLED) return { allowed: true, reason: null, category: null };
  if (typeof text !== "string" || !text.trim()) return { allowed: true, reason: null, category: null };

  let result;
  if (process.env.MODERATION_API_URL) {
    result = await callModerationApi(text);
  } else {
    result = matchPatterns(text);
  }

  if (!result.allowed) {
    recordModerationBlock(result.category, "output");
  }
  return result;
}

export function inputModerationMiddleware() {
  return async function moderationMiddleware(req, res, next) {
    if (!MODERATION_ENABLED) return next();
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return next();
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : null;
    if (!content) return next();

    try {
      const result = await checkInput(content, {
        workspaceId: req.body?.agentOptions?.workspace,
        userId: req.userId,
      });
      if (!result.allowed) {
        return res.status(400).json({ error: "Content policy violation", category: result.category });
      }
    } catch (err) {
      console.warn("[safety-gate] Moderation check failed (fail-open):", err?.message || err);
    }
    next();
  };
}
