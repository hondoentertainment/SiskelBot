/**
 * In-browser chat over the offline catalog.
 * The default engine answers on device from the catalog card and does not
 * call a hosted model. A WebLLM engine can be injected when the page has
 * loaded a vendored runtime. This module does not download weights.
 */
import { OFFLINE_MODELS } from "./offline-models.js";

/** Optional WebLLM model ids. Weights are not fetched by this module. */
export const WEBLLM_MODEL_IDS = Object.freeze({
  "tinyllama-1.1b-q4": "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC",
  "phi-2-q4": "Phi-2-q4f16_1-MLC",
  "gemma-2b-q4": "gemma-2b-it-q4f16_1-MLC",
});

export function listBrowserChatModels() {
  return Object.values(OFFLINE_MODELS)
    .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes("chat"))
    .map((model) => ({
      id: model.id,
      name: model.name,
      family: model.family,
      contextLength: model.contextLength,
      sizeBytes: model.sizeBytes || 0,
      license: model.license,
      description: model.description,
      webllmId: WEBLLM_MODEL_IDS[model.id] || null,
      runtime: "catalog",
    }));
}

export function getBrowserChatModel(modelId) {
  return listBrowserChatModels().find((model) => model.id === modelId) || null;
}

/**
 * On-device reply used when WebLLM weights are not loaded.
 * It never calls fetch.
 */
/**
 * Decide whether the page should ask, download weights, or stay on the catalog reply.
 * Consent is explicit. No download starts until consent is true and WebGPU exists.
 */
export function webllmLoadPlan({ model, webgpuAvailable, consent }) {
  const bytes = Number(model?.sizeBytes) || 0;
  if (!model) return { mode: "error", bytes, reason: "Unknown model" };
  if (!webgpuAvailable) {
    return {
      mode: "catalog",
      bytes,
      reason: "WebGPU is not available in this browser. Answers stay on the catalog reply.",
    };
  }
  if (!model.webllmId) {
    return { mode: "catalog", bytes, reason: "This catalog model has no in-browser weight build." };
  }
  if (!consent) {
    return {
      mode: "consent",
      bytes,
      webllmId: model.webllmId,
      reason: "Confirm the download to load weights in this browser. They are cached after the first load.",
    };
  }
  return { mode: "webllm", bytes, webllmId: model.webllmId };
}

export function catalogEchoEngine(model) {
  return async function complete(messages) {
    const last = [...(messages || [])].reverse().find((message) => message?.role === "user");
    const said = String(last?.content || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const name = model?.name || "Offline model";
    if (!said) return `${name} is ready in the browser. Ask a question to continue.`;
    return `${name} is running in the browser without a network request. You said: ${said}`;
  };
}

/**
 * Adapter for a vendored WebLLM CreateMLCEngine. The caller supplies the factory.
 * @param {Function} createMLCEngine
 * @param {{ webllmId: string }} model
 */
export function webllmEngine(createMLCEngine, model) {
  if (typeof createMLCEngine !== "function") {
    throw new Error("createMLCEngine is required");
  }
  if (!model?.webllmId) {
    throw new Error("This catalog model has no WebLLM id");
  }
  let engine = null;
  return async function complete(messages) {
    if (!engine) {
      engine = await createMLCEngine(model.webllmId);
    }
    const out = await engine.chat.completions.create({ messages, stream: false });
    return out?.choices?.[0]?.message?.content || "";
  };
}

/**
 * @param {{ modelId: string, messages: object[], engine?: Function }} input
 */
export async function completeOfflineTurn(input = {}) {
  const model = getBrowserChatModel(input.modelId);
  if (!model) {
    return { ok: false, code: "UNKNOWN_MODEL", error: "Model is not in the offline browser catalog" };
  }
  const messages = Array.isArray(input.messages) ? input.messages.slice(-24) : [];
  const engine = typeof input.engine === "function" ? input.engine : catalogEchoEngine(model);
  const content = await engine(messages, model);
  return {
    ok: true,
    modelId: model.id,
    runtime: typeof input.engine === "function" ? "custom" : "catalog",
    network: false,
    content: String(content || ""),
  };
}
