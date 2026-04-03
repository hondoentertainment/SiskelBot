/**
 * Word Count Plugin — Example SiskelBot JS plugin.
 * Counts words, characters, and lines in the provided input.
 */
export const name = "word-count";
export const version = "1.0.0";
export const description = "Counts words, characters, and lines in input text";

/**
 * @param {{ input: string; workspaceId?: string; userId?: string; config?: object }} context
 * @returns {Promise<{ output: string; metadata?: object }>}
 */
export async function execute(context) {
  const text = context.input || "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const characters = text.length;
  const lines = text ? text.split(/\r?\n/).length : 0;

  return {
    output: `Words: ${words}, Characters: ${characters}, Lines: ${lines}`,
    metadata: { words, characters, lines },
  };
}
