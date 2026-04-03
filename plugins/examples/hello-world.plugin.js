/**
 * Hello World Plugin — Example SiskelBot JS plugin.
 * Returns a greeting with the provided input.
 */
export const name = "hello-world";
export const version = "1.0.0";
export const description = "Returns a friendly greeting";

/**
 * @param {{ input: string; workspaceId?: string; userId?: string; config?: object }} context
 * @returns {Promise<{ output: string; metadata?: object }>}
 */
export async function execute(context) {
  const who = context.input?.trim() || "World";
  return {
    output: `Hello, ${who}!`,
    metadata: { greeted: who },
  };
}
