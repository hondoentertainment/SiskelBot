/**
 * Voice navigation: registers voice commands and dispatches them
 * to handlers that perform UI navigation, searches, recipe runs, etc.
 *
 * @module lib/voice-navigation
 */

import { parseVoiceCommand, VOICE_COMMAND_GRAMMAR } from "./wake-word.js";

/**
 * Registry of voice commands. Each entry maps an action name to a handler
 * plus metadata used by getCommandHelp().
 *
 * @type {Map<string, { handler: Function, description: string, pattern: string }>}
 */
const commandRegistry = new Map();

/**
 * Mutable grammar table that includes the defaults from VOICE_COMMAND_GRAMMAR
 * plus any patterns added via registerVoiceCommand.
 */
const grammar = Object.assign({}, VOICE_COMMAND_GRAMMAR);

/**
 * Register a voice command. The handler is called when a transcript
 * matches the pattern and is invoked as `handler(params, context)`.
 *
 * @param {string} pattern - Grammar pattern (see VOICE_COMMAND_GRAMMAR)
 * @param {Function} handler - Async handler invoked with (params, context)
 * @param {object} [meta]
 * @param {string} [meta.action] - Action name (defaults to pattern)
 * @param {string} [meta.description]
 */
export function registerVoiceCommand(pattern, handler, meta = {}) {
  if (typeof pattern !== "string" || !pattern.trim()) {
    throw new TypeError("pattern must be a non-empty string");
  }
  if (typeof handler !== "function") {
    throw new TypeError("handler must be a function");
  }
  const action = meta.action || pattern.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  grammar[pattern] = { action, description: meta.description || "" };
  commandRegistry.set(action, {
    handler,
    description: meta.description || "",
    pattern,
  });
  return { action, pattern };
}

/**
 * Remove a previously registered command.
 * @param {string} pattern
 */
export function unregisterVoiceCommand(pattern) {
  const entry = grammar[pattern];
  if (!entry) return false;
  delete grammar[pattern];
  commandRegistry.delete(entry.action);
  return true;
}

/**
 * Reset the registry to defaults (useful for tests).
 */
export function resetVoiceCommands() {
  commandRegistry.clear();
  for (const k of Object.keys(grammar)) delete grammar[k];
  Object.assign(grammar, VOICE_COMMAND_GRAMMAR);
  registerDefaultHandlers();
}

/**
 * Default no-op handlers for the built-in grammar. These produce
 * descriptive responses but do not actually mutate state — clients are
 * expected to receive the parsed action and execute it locally.
 */
function registerDefaultHandlers() {
  const defaults = [
    ["new_conversation", () => ({ ok: true, message: "Started a new conversation." })],
    ["search", (params) => ({ ok: true, message: `Searching for "${params.query || ""}".`, query: params.query || "" })],
    ["navigate", (params) => ({ ok: true, message: `Navigating to ${params.destination || "home"}.`, destination: params.destination || "home" })],
    ["run_recipe", (params) => ({ ok: true, message: `Running recipe "${params.name || ""}".`, name: params.name || "" })],
    ["interrupt", () => ({ ok: true, message: "Interrupted current operation." })],
    ["delete_message", (params) => ({ ok: true, message: `Deleted ${params.choice || "current"} message.`, target: params.choice || "current" })],
    ["regenerate", () => ({ ok: true, message: "Regenerating last response." })],
    ["send_message", (params) => ({ ok: true, message: "Sending message.", text: params.text || "" })],
    ["switch_model", (params) => ({ ok: true, message: `Switched model to ${params.name || ""}.`, model: params.name || "" })],
    ["switch_workspace", (params) => ({ ok: true, message: `Switched workspace to ${params.name || ""}.`, workspace: params.name || "" })],
    ["help", () => ({ ok: true, message: "Listing available voice commands.", commands: getCommandHelp() })],
  ];
  for (const [action, handler] of defaults) {
    if (!commandRegistry.has(action)) {
      // Find the first grammar pattern that maps to this action so help is descriptive.
      const pattern = Object.keys(VOICE_COMMAND_GRAMMAR).find((p) => VOICE_COMMAND_GRAMMAR[p].action === action) || action;
      const description = (VOICE_COMMAND_GRAMMAR[pattern] && VOICE_COMMAND_GRAMMAR[pattern].description) || "";
      commandRegistry.set(action, { handler, description, pattern });
    }
  }
}

// Bootstrap default handlers on module load.
registerDefaultHandlers();

/**
 * Parse and execute a voice command.
 *
 * @param {string} transcript
 * @param {object} [context] - Arbitrary execution context (user, workspace, etc.)
 * @returns {Promise<{ executed: boolean, action: string|null, result: any, response: string, parsed: object }>}
 */
export async function executeVoiceCommand(transcript, context = {}) {
  const parsed = parseVoiceCommand(transcript, { grammar });
  if (!parsed.action) {
    return {
      executed: false,
      action: null,
      result: null,
      response: "Sorry, I didn't understand that command.",
      parsed,
    };
  }

  const entry = commandRegistry.get(parsed.action);
  if (!entry) {
    return {
      executed: false,
      action: parsed.action,
      result: null,
      response: `No handler registered for action "${parsed.action}".`,
      parsed,
    };
  }

  try {
    const result = await entry.handler(parsed.params, context);
    const response =
      (result && typeof result === "object" && typeof result.message === "string")
        ? result.message
        : `Executed ${parsed.action}.`;
    return {
      executed: true,
      action: parsed.action,
      result,
      response,
      parsed,
    };
  } catch (err) {
    return {
      executed: false,
      action: parsed.action,
      result: null,
      response: `Failed to execute ${parsed.action}: ${err.message}`,
      parsed,
      error: err.message,
    };
  }
}

/**
 * Return a list of all registered commands with their descriptions.
 * Suitable for displaying in a help dialog or returning from /help.
 *
 * @returns {Array<{ action: string, pattern: string, description: string }>}
 */
export function getCommandHelp() {
  const list = [];
  // Include all grammar patterns so help reflects natural-language phrasing.
  const seenActions = new Set();
  for (const [pattern, entry] of Object.entries(grammar)) {
    list.push({
      action: entry.action,
      pattern,
      description: entry.description || "",
    });
    seenActions.add(entry.action);
  }
  // Include actions registered via registerVoiceCommand whose pattern
  // wasn't already added above.
  for (const [action, entry] of commandRegistry.entries()) {
    if (seenActions.has(action)) continue;
    list.push({
      action,
      pattern: entry.pattern,
      description: entry.description || "",
    });
  }
  return list;
}

/**
 * Get the live grammar table (used by routes for parse-only requests).
 */
export function getGrammar() {
  return Object.assign({}, grammar);
}

/**
 * Get the registered command count (mostly for tests/metrics).
 */
export function getCommandCount() {
  return commandRegistry.size;
}
