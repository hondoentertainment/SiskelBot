/**
 * Phase 72: Fixed-size text chunking with overlap for knowledge indexing.
 * Phase 17: Added sentence, paragraph, and heading chunking strategies.
 */

/**
 * Fixed-size chunking (original behavior). Tries to break at natural boundaries.
 * @param {string} text
 * @param {number} maxChars - target max characters per chunk
 * @param {number} overlap - characters repeated between consecutive chunks
 * @returns {string[]}
 */
export function chunkPlainText(text, maxChars = 4000, overlap = 200) {
  return chunkByFixed(text, maxChars, overlap);
}

/**
 * Chunk using the specified strategy.
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.strategy='fixed'] - 'fixed' | 'sentence' | 'paragraph' | 'heading'
 * @param {number} [opts.maxChars=4000]
 * @param {number} [opts.overlap=200]
 * @returns {string[]}
 */
export function chunkWithStrategy(text, opts = {}) {
  const { strategy = "fixed", maxChars = 4000, overlap = 200 } = opts;
  switch (strategy) {
    case "sentence":
      return chunkBySentence(text, maxChars, overlap);
    case "paragraph":
      return chunkByParagraph(text, maxChars, overlap);
    case "heading":
      return chunkByHeading(text, maxChars);
    case "fixed":
    default:
      return chunkByFixed(text, maxChars, overlap);
  }
}

/**
 * Fixed-size chunking with overlap. Tries to break at natural boundaries.
 * @param {string} text
 * @param {number} maxChars
 * @param {number} overlap
 * @returns {string[]}
 */
export function chunkByFixed(text, maxChars = 4000, overlap = 200) {
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

/**
 * Sentence-boundary chunking. Splits text at sentence endings (. ! ?)
 * and groups sentences until maxChars is reached.
 * @param {string} text
 * @param {number} maxChars
 * @param {number} overlap - number of characters to overlap between chunks
 * @returns {string[]}
 */
export function chunkBySentence(text, maxChars = 4000, overlap = 200) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return [];
  const max = Math.max(64, Math.min(32_000, maxChars));
  const ov = Math.max(0, Math.min(Math.floor(max / 2), overlap));
  if (t.length <= max) return [t];

  // Split into sentences at . ! ? followed by whitespace, or at double newlines
  const parts = t.split(/(?<=[.!?])\s+|(?:\n{2,})/);
  const sentences = parts.map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return chunkByFixed(t, max, ov);

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const sentence of sentences) {
    const addLen = current.length > 0 ? sentence.length + 1 : sentence.length;
    if (currentLen + addLen > max && current.length > 0) {
      chunks.push(current.join(" "));
      // Overlap: keep trailing sentences that fit within overlap chars
      if (ov > 0) {
        let overlapLen = 0;
        let overlapStart = current.length;
        for (let i = current.length - 1; i >= 0; i--) {
          overlapLen += current[i].length + 1;
          if (overlapLen > ov) break;
          overlapStart = i;
        }
        current = current.slice(overlapStart);
        currentLen = current.reduce((sum, s) => sum + s.length + 1, 0) - 1;
        if (currentLen < 0) currentLen = 0;
      } else {
        current = [];
        currentLen = 0;
      }
    }
    // If a single sentence exceeds max, split it with fixed chunking
    if (sentence.length > max) {
      if (current.length > 0) {
        chunks.push(current.join(" "));
        current = [];
        currentLen = 0;
      }
      chunks.push(...chunkByFixed(sentence, max, ov));
      continue;
    }
    current.push(sentence);
    currentLen = current.reduce((sum, s) => sum + s.length + 1, 0) - 1;
  }

  if (current.length > 0) {
    const last = current.join(" ").trim();
    if (last) chunks.push(last);
  }

  return chunks;
}

/**
 * Paragraph-boundary chunking. Splits at double newlines and groups
 * paragraphs until maxChars is reached.
 * @param {string} text
 * @param {number} maxChars
 * @param {number} overlap - number of characters to overlap between chunks
 * @returns {string[]}
 */
export function chunkByParagraph(text, maxChars = 4000, overlap = 200) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return [];
  const max = Math.max(64, Math.min(32_000, maxChars));
  const ov = Math.max(0, Math.min(Math.floor(max / 2), overlap));
  if (t.length <= max) return [t];

  const paragraphs = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return chunkByFixed(t, max, ov);

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const addLen = current.length > 0 ? para.length + 2 : para.length; // +2 for \n\n separator
    if (currentLen + addLen > max && current.length > 0) {
      chunks.push(current.join("\n\n"));
      // Overlap: keep trailing paragraphs within overlap chars
      if (ov > 0) {
        let overlapLen = 0;
        let overlapStart = current.length;
        for (let i = current.length - 1; i >= 0; i--) {
          overlapLen += current[i].length + 2;
          if (overlapLen > ov) break;
          overlapStart = i;
        }
        current = current.slice(overlapStart);
        currentLen = current.reduce((sum, s) => sum + s.length + 2, 0) - 2;
        if (currentLen < 0) currentLen = 0;
      } else {
        current = [];
        currentLen = 0;
      }
    }
    // If a single paragraph exceeds max, split it with fixed chunking
    if (para.length > max) {
      if (current.length > 0) {
        chunks.push(current.join("\n\n"));
        current = [];
        currentLen = 0;
      }
      chunks.push(...chunkByFixed(para, max, ov));
      continue;
    }
    current.push(para);
    currentLen = current.reduce((sum, s) => sum + s.length + 2, 0) - 2;
  }

  if (current.length > 0) {
    const last = current.join("\n\n").trim();
    if (last) chunks.push(last);
  }

  return chunks;
}

/**
 * Heading-boundary chunking. Splits at markdown headings (# ## ###).
 * Each heading starts a new chunk. If a section exceeds maxChars,
 * it is sub-chunked with fixed strategy.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function chunkByHeading(text, maxChars = 4000) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return [];
  const max = Math.max(64, Math.min(32_000, maxChars));
  if (t.length <= max) return [t];

  // Split at heading boundaries (# through ######)
  const sections = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let lastIndex = 0;
  let match;

  while ((match = headingRegex.exec(t)) !== null) {
    // Content before this heading (or between previous heading and this one)
    if (match.index > lastIndex) {
      const before = t.slice(lastIndex, match.index).trim();
      if (before) {
        if (sections.length > 0) {
          sections[sections.length - 1] += "\n\n" + before;
        } else {
          sections.push(before);
        }
      }
    }
    // Start a new section with this heading
    sections.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  // Remaining content after last heading
  if (lastIndex < t.length) {
    const remaining = t.slice(lastIndex).trim();
    if (remaining) {
      if (sections.length > 0) {
        sections[sections.length - 1] += "\n\n" + remaining;
      } else {
        sections.push(remaining);
      }
    }
  }

  if (sections.length === 0) return chunkByFixed(t, max, 0);

  // Sub-chunk any section that exceeds maxChars
  const chunks = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= max) {
      chunks.push(trimmed);
    } else {
      chunks.push(...chunkByFixed(trimmed, max, 0));
    }
  }

  return chunks;
}
