/**
 * OpenAI fine-tuning provider.
 * Thin REST wrapper around the OpenAI fine-tune endpoints using fetch.
 * All functions accept an explicit apiKey; they do not read env directly so
 * tests can inject credentials.
 */

const DEFAULT_BASE_URL = () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function authHeaders(apiKey) {
  if (!apiKey) throw new Error("OpenAI apiKey is required");
  return { Authorization: `Bearer ${apiKey}` };
}

async function requestJson(url, init, errorContext) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || text || `HTTP ${res.status}`;
    throw new Error(`${errorContext}: ${msg}`);
  }
  return body;
}

/**
 * Upload a training file to OpenAI (/v1/files, purpose=fine-tune).
 * @param {string} fileContent - JSONL content as a string
 * @param {string} apiKey
 * @param {{ filename?: string, baseUrl?: string }} [opts]
 * @returns {Promise<string>} file id
 */
export async function uploadTrainingFile(fileContent, apiKey, opts = {}) {
  if (typeof fileContent !== "string" || !fileContent.length) {
    throw new Error("fileContent is required");
  }
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();
  const filename = opts.filename || "training.jsonl";

  const form = new FormData();
  form.append("purpose", "fine-tune");
  const blob = new Blob([fileContent], { type: "application/jsonl" });
  form.append("file", blob, filename);

  const body = await requestJson(
    `${baseUrl}/files`,
    { method: "POST", headers: { ...authHeaders(apiKey) }, body: form },
    "openai file upload failed",
  );
  if (!body?.id) throw new Error("openai file upload failed: no id in response");
  return body.id;
}

/**
 * Create a fine-tune job.
 * @param {{
 *   model: string,
 *   trainingFile: string,         // OpenAI file id
 *   validationFile?: string|null, // OpenAI file id
 *   hyperparameters?: object,
 *   suffix?: string,
 * }} config
 * @param {string} apiKey
 * @param {{ baseUrl?: string }} [opts]
 * @returns {Promise<object>} raw fine-tune response
 */
export async function createFineTune(config, apiKey, opts = {}) {
  if (!config?.model) throw new Error("model is required");
  if (!config?.trainingFile) throw new Error("trainingFile is required");
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();

  const payload = {
    model: config.model,
    training_file: config.trainingFile,
  };
  if (config.validationFile) payload.validation_file = config.validationFile;
  if (config.hyperparameters && typeof config.hyperparameters === "object") {
    payload.hyperparameters = config.hyperparameters;
  }
  if (config.suffix) payload.suffix = config.suffix;

  return requestJson(
    `${baseUrl}/fine_tuning/jobs`,
    {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "openai create fine-tune failed",
  );
}

/**
 * List fine-tune jobs.
 * @param {string} apiKey
 * @param {{ baseUrl?: string, limit?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listFineTunes(apiKey, opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();
  const qs = opts.limit ? `?limit=${encodeURIComponent(opts.limit)}` : "";
  const body = await requestJson(
    `${baseUrl}/fine_tuning/jobs${qs}`,
    { method: "GET", headers: { ...authHeaders(apiKey) } },
    "openai list fine-tunes failed",
  );
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * Get a single fine-tune job.
 * @param {string} jobId
 * @param {string} apiKey
 * @param {{ baseUrl?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function getFineTune(jobId, apiKey, opts = {}) {
  if (!jobId) throw new Error("jobId is required");
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();
  return requestJson(
    `${baseUrl}/fine_tuning/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET", headers: { ...authHeaders(apiKey) } },
    "openai get fine-tune failed",
  );
}

/**
 * Cancel a fine-tune job.
 * @param {string} jobId
 * @param {string} apiKey
 * @param {{ baseUrl?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function cancelFineTune(jobId, apiKey, opts = {}) {
  if (!jobId) throw new Error("jobId is required");
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();
  return requestJson(
    `${baseUrl}/fine_tuning/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", headers: { ...authHeaders(apiKey) } },
    "openai cancel fine-tune failed",
  );
}

/**
 * Fetch events for a fine-tune job.
 * @param {string} jobId
 * @param {string} apiKey
 * @param {{ baseUrl?: string, limit?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function getFineTuneEvents(jobId, apiKey, opts = {}) {
  if (!jobId) throw new Error("jobId is required");
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL();
  const qs = opts.limit ? `?limit=${encodeURIComponent(opts.limit)}` : "";
  const body = await requestJson(
    `${baseUrl}/fine_tuning/jobs/${encodeURIComponent(jobId)}/events${qs}`,
    { method: "GET", headers: { ...authHeaders(apiKey) } },
    "openai get fine-tune events failed",
  );
  return Array.isArray(body?.data) ? body.data : [];
}
