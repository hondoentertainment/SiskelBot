/**
 * Phase 55: Strict tool argument validation before execution.
 * Invalid calls return structured tool messages so the model can repair on the next iteration.
 */
const KNOWN_TOOLS = new Set(["execute_step", "search_context", "list_context", "get_recipe"]);

/**
 * @param {string|null|undefined} name
 * @param {object} args - parsed arguments (may be empty object if JSON.parse failed)
 * @param {{ parseError?: string|null }} [opts]
 * @returns {{ valid: boolean; errors: string[]; repairHint: string }}
 */
export function validateToolCall(name, args, opts = {}) {
  const errors = [];
  const parseError = opts.parseError;

  if (parseError) {
    errors.push(`Invalid JSON in function.arguments: ${parseError}`);
    return {
      valid: false,
      errors,
      repairHint:
        "function.arguments must be valid JSON matching the tool schema. " +
        "For example search_context requires {\"query\": \"your search text\"}.",
    };
  }

  if (!name || typeof name !== "string") {
    errors.push("Missing or invalid function name");
    return { valid: false, errors, repairHint: "Use one of the registered tool names." };
  }

  if (!KNOWN_TOOLS.has(name)) {
    errors.push(`Unknown tool "${name}"`);
    return {
      valid: false,
      errors,
      repairHint: `Valid tools: ${[...KNOWN_TOOLS].join(", ")}`,
    };
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    errors.push("Arguments must be a JSON object");
    return { valid: false, errors, repairHint: "Pass a single JSON object as function.arguments." };
  }

  switch (name) {
    case "execute_step": {
      const action = args.action;
      if (typeof action !== "string" || !action.trim()) {
        errors.push("execute_step requires non-empty string property `action`");
      }
      break;
    }
    case "search_context": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("search_context requires non-empty string property `query`");
      }
      break;
    }
    case "list_context":
      break;
    case "get_recipe": {
      if (typeof args.name !== "string" || !args.name.trim()) {
        errors.push("get_recipe requires non-empty string property `name`");
      }
      break;
    }
    default:
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    repairHint: errors.join("; "),
  };
}

export function toolValidationEnabled() {
  return process.env.TOOL_VALIDATION_STRICT !== "0";
}
