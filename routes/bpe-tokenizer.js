/**
 * BPE tokenizer routes — expose Karpathy's minBPE tokenizer over HTTP.
 *
 *   POST /api/v1/tokenizer/train   — train a tokenizer on a text corpus
 *   POST /api/v1/tokenizer/encode  — tokenize text to ids
 *   POST /api/v1/tokenizer/decode  — detokenize ids back to text
 *   GET  /api/v1/tokenizer/vocab   — inspect the learned vocab (admin/small)
 *   POST /api/v1/tokenizer/count   — count tokens in text
 *
 * A single in-process tokenizer per (user, workspace) is kept in a Map.
 * Trained models are not persisted to storage — this endpoint is intended
 * for interactive exploration, not production tokenization.
 */

import {
  BasicBPETokenizer,
  RegexBPETokenizer,
  GPT2_SPLIT_PATTERN,
  GPT4_SPLIT_PATTERN,
  countTokens,
} from "../lib/bpe-tokenizer.js";

const MAX_TRAIN_BYTES = 2 * 1024 * 1024; // 2 MiB corpus cap
const MAX_VOCAB_SIZE = 8192;
const MAX_ENCODE_BYTES = 512 * 1024; // 512 KiB per encode call
const MAX_DECODE_IDS = 200_000;
const INSPECTABLE_VOCAB_SIZE = 2048;

// key: `${userId}:${workspace}` -> tokenizer instance
const tokenizers = new Map();

function keyFor(userId, workspace) {
  return `${userId || "anonymous"}:${workspace || "default"}`;
}

function buildTokenizer(kind, patternName) {
  if (kind === "basic") return new BasicBPETokenizer();
  const pattern =
    patternName === "gpt2"
      ? GPT2_SPLIT_PATTERN
      : patternName === "gpt4"
        ? GPT4_SPLIT_PATTERN
        : GPT4_SPLIT_PATTERN;
  return new RegexBPETokenizer(pattern);
}

function serializeVocabEntry(id, bytes) {
  // Return both the raw bytes as an array and a lossy UTF-8 preview so the
  // client can inspect tokens that cross codepoint boundaries.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    id,
    bytes: Array.from(bytes),
    preview: decoder.decode(bytes),
  };
}

export function mountBpeTokenizerRoutes(app, deps) {
  const { apiRoute, apiError, sanitizeWorkspace, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  // POST /api/v1/tokenizer/train
  apiRoute("post", "/tokenizer/train", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { text, vocabSize, kind, pattern, specialTokens } = req.body || {};

      if (typeof text !== "string" || text.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const byteLen = Buffer.byteLength(text, "utf8");
      if (byteLen > MAX_TRAIN_BYTES) {
        return apiError(
          res,
          413,
          "PAYLOAD_TOO_LARGE",
          `text exceeds max corpus size (${MAX_TRAIN_BYTES} bytes)`,
        );
      }
      const vs = Number(vocabSize);
      if (!Number.isFinite(vs) || vs < 256 || vs > MAX_VOCAB_SIZE) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `vocabSize must be an integer in [256, ${MAX_VOCAB_SIZE}]`,
        );
      }

      const kindNormalized = kind === "basic" ? "basic" : "regex";
      const tokenizer = buildTokenizer(kindNormalized, pattern);
      tokenizer.train(text, Math.floor(vs), false);

      if (specialTokens && typeof specialTokens === "object") {
        for (const [tok, id] of Object.entries(specialTokens)) {
          tokenizer.registerSpecialToken(tok, Number(id));
        }
      }

      tokenizers.set(keyFor(userId, workspace), tokenizer);

      return res.json({
        _version: 1,
        kind: kindNormalized,
        vocabSize: tokenizer.getVocabSize(),
        merges: tokenizer.merges.size,
        specialTokens: Array.from(tokenizer.specialTokens.keys()),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tokenizer/encode
  apiRoute("post", "/tokenizer/encode", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { text, allowSpecial } = req.body || {};

      if (typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_ENCODE_BYTES) {
        return apiError(
          res,
          413,
          "PAYLOAD_TOO_LARGE",
          `text exceeds max encode size (${MAX_ENCODE_BYTES} bytes)`,
        );
      }

      const tokenizer = tokenizers.get(keyFor(userId, workspace));
      if (!tokenizer) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          "no tokenizer trained for this workspace; call /tokenizer/train first",
        );
      }

      const opts = {};
      if (allowSpecial === "all" || allowSpecial === "none") {
        opts.allowSpecial = allowSpecial;
      }
      const ids =
        tokenizer instanceof RegexBPETokenizer
          ? tokenizer.encode(text, opts)
          : tokenizer.encode(text);

      return res.json({
        _version: 1,
        ids,
        count: ids.length,
      });
    } catch (err) {
      return apiError(res, 400, "ENCODE_FAILED", err.message);
    }
  });

  // POST /api/v1/tokenizer/decode
  apiRoute("post", "/tokenizer/decode", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { ids } = req.body || {};

      if (!Array.isArray(ids)) {
        return apiError(res, 400, "INVALID_INPUT", "ids must be an array");
      }
      if (ids.length > MAX_DECODE_IDS) {
        return apiError(
          res,
          413,
          "PAYLOAD_TOO_LARGE",
          `ids exceeds max length (${MAX_DECODE_IDS})`,
        );
      }
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 0) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "ids must be non-negative integers",
          );
        }
      }

      const tokenizer = tokenizers.get(keyFor(userId, workspace));
      if (!tokenizer) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          "no tokenizer trained for this workspace; call /tokenizer/train first",
        );
      }
      const text = tokenizer.decode(ids);
      return res.json({ _version: 1, text });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/tokenizer/vocab
  apiRoute("get", "/tokenizer/vocab", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace(req.query?.workspace);

      const tokenizer = tokenizers.get(keyFor(userId, workspace));
      if (!tokenizer) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          "no tokenizer trained for this workspace; call /tokenizer/train first",
        );
      }

      const isAdmin = Boolean(req.isAdmin || req.user?.isAdmin);
      if (tokenizer.getVocabSize() > INSPECTABLE_VOCAB_SIZE && !isAdmin) {
        return apiError(
          res,
          403,
          "FORBIDDEN",
          `vocab inspection requires admin access when vocabSize > ${INSPECTABLE_VOCAB_SIZE}`,
        );
      }

      const limit = Math.min(
        Number(req.query?.limit) || tokenizer.getVocabSize(),
        tokenizer.getVocabSize(),
      );
      const offset = Math.max(Number(req.query?.offset) || 0, 0);

      const entries = [];
      let seen = 0;
      for (const [id, bytes] of tokenizer.vocab) {
        if (seen >= offset && entries.length < limit) {
          entries.push(serializeVocabEntry(id, bytes));
        }
        seen += 1;
        if (entries.length >= limit) break;
      }

      return res.json({
        _version: 1,
        vocabSize: tokenizer.getVocabSize(),
        offset,
        limit,
        entries,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tokenizer/count
  apiRoute("post", "/tokenizer/count", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { text } = req.body || {};

      if (typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_ENCODE_BYTES) {
        return apiError(
          res,
          413,
          "PAYLOAD_TOO_LARGE",
          `text exceeds max size (${MAX_ENCODE_BYTES} bytes)`,
        );
      }

      const tokenizer = tokenizers.get(keyFor(userId, workspace)) || null;
      const count = countTokens(text, tokenizer);
      return res.json({
        _version: 1,
        count,
        tokenizer: tokenizer ? "workspace" : "heuristic",
        bytes: Buffer.byteLength(text, "utf8"),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountBpeTokenizerRoutes;
