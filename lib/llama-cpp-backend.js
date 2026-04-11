/**
 * Phase 40.5: Optional llama.cpp backend for local inference of downloaded
 * GGUF models. Dynamically imports `node-llama-cpp` so the dependency stays
 * optional — if the native module is not installed, the rest of the app
 * continues to work and `isLlamaCppAvailable()` returns false.
 *
 * Usage:
 *   import { isLlamaCppAvailable, createLlamaCppBackend } from "./llama-cpp-backend.js";
 *   if (await isLlamaCppAvailable()) {
 *     const backend = await createLlamaCppBackend({ modelPath });
 *     const text = await backend.generate("Hello", { maxTokens: 64 });
 *   }
 */
import { existsSync } from "fs";

let cachedAvailability = null;

/**
 * Returns true if `node-llama-cpp` can be imported in this environment.
 * The result is memoized for the lifetime of the process.
 */
export async function isLlamaCppAvailable() {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    await import("node-llama-cpp");
    cachedAvailability = true;
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

/**
 * Reset the memoized availability check (useful for tests).
 */
export function _resetLlamaCppAvailability() {
  cachedAvailability = null;
}

/**
 * Create a thin wrapper around node-llama-cpp's chat API.
 *
 * @param {{ modelPath: string, contextSize?: number, gpuLayers?: number }} options
 * @returns {Promise<{
 *   modelPath: string,
 *   generate: (prompt: string, opts?: { maxTokens?: number, temperature?: number }) => Promise<string>,
 *   chat: (messages: Array<{role: string, content: string}>, opts?: object) => Promise<string>,
 *   embed: (text: string) => Promise<number[]>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function createLlamaCppBackend(options) {
  if (!options || typeof options.modelPath !== "string") {
    throw new Error("modelPath is required");
  }
  if (!existsSync(options.modelPath)) {
    throw new Error(`model file not found: ${options.modelPath}`);
  }
  const available = await isLlamaCppAvailable();
  if (!available) {
    throw new Error(
      "node-llama-cpp is not installed. Run `npm install node-llama-cpp` to enable the llamacpp backend."
    );
  }

  const llama = await import("node-llama-cpp");
  const getLlama = llama.getLlama || llama.default?.getLlama;
  if (typeof getLlama !== "function") {
    throw new Error("node-llama-cpp installed but getLlama() not exported (incompatible version)");
  }

  const llamaInstance = await getLlama();
  const model = await llamaInstance.loadModel({
    modelPath: options.modelPath,
    gpuLayers: options.gpuLayers ?? 0,
  });
  const context = await model.createContext({
    contextSize: options.contextSize ?? 2048,
  });

  // The chat session API differs slightly across versions; we use the
  // most stable surface and gracefully feature-detect.
  const ChatSession = llama.LlamaChatSession || llama.default?.LlamaChatSession;
  let session = null;
  if (ChatSession) {
    session = new ChatSession({ contextSequence: context.getSequence() });
  }

  return {
    modelPath: options.modelPath,
    async generate(prompt, opts = {}) {
      if (typeof prompt !== "string") throw new Error("prompt must be a string");
      if (session && typeof session.prompt === "function") {
        return session.prompt(prompt, {
          maxTokens: opts.maxTokens ?? 256,
          temperature: opts.temperature ?? 0.7,
        });
      }
      throw new Error("chat session not available in this node-llama-cpp version");
    },
    async chat(messages, opts = {}) {
      if (!Array.isArray(messages)) throw new Error("messages must be an array");
      const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
      if (!lastUser) throw new Error("no user message found");
      return this.generate(lastUser.content, opts);
    },
    async embed(text) {
      if (typeof text !== "string") throw new Error("text must be a string");
      if (typeof model.embed === "function") {
        return model.embed(text);
      }
      throw new Error("embedding not supported by this model/version");
    },
    async dispose() {
      try {
        if (context && typeof context.dispose === "function") await context.dispose();
      } catch {}
      try {
        if (model && typeof model.dispose === "function") await model.dispose();
      } catch {}
    },
  };
}

/**
 * Convenience: returns the list of backend names this module contributes
 * to the chat router. When llama.cpp is unavailable, returns an empty array.
 */
export async function getLlamaCppBackendNames() {
  const ok = await isLlamaCppAvailable();
  return ok ? ["llamacpp"] : [];
}

export default {
  isLlamaCppAvailable,
  createLlamaCppBackend,
  getLlamaCppBackendNames,
  _resetLlamaCppAvailability,
};
