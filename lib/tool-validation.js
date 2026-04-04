/**
 * Phase 55: Strict tool argument validation before execution.
 * Invalid calls return structured tool messages so the model can repair on the next iteration.
 */
const KNOWN_TOOLS = new Set([
  "execute_step",
  "search_context",
  "list_context",
  "semantic_search_context",
  "get_context_document",
  "list_recipes",
  "get_recipe",
  "remember_workspace_fact",
  "list_workspace_memory",
  "fetch_allowed_url",
  "workspace_list_dir",
  "workspace_read_file",
  "workspace_search_text",
  "workspace_write_file",
  "workspace_git_status",
  "workspace_git_log",
  "workspace_git_diff",
  "workspace_git_commit",
  "workspace_run_command",
  "browser_open_extract_text",
]);

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
    case "semantic_search_context": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("semantic_search_context requires non-empty string property `query`");
      }
      break;
    }
    case "get_context_document": {
      if (typeof args.id !== "string" || !args.id.trim()) {
        errors.push("get_context_document requires non-empty string property `id`");
      }
      break;
    }
    case "list_recipes":
      break;
    case "get_recipe": {
      if (typeof args.name !== "string" || !args.name.trim()) {
        errors.push("get_recipe requires non-empty string property `name`");
      }
      break;
    }
    case "remember_workspace_fact": {
      if (typeof args.fact !== "string" || !args.fact.trim()) {
        errors.push("remember_workspace_fact requires non-empty string property `fact`");
      }
      break;
    }
    case "list_workspace_memory":
      break;
    case "fetch_allowed_url": {
      if (typeof args.url !== "string" || !args.url.trim()) {
        errors.push("fetch_allowed_url requires non-empty string property `url`");
      }
      break;
    }
    case "workspace_list_dir":
      break;
    case "workspace_read_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        errors.push("workspace_read_file requires non-empty string property `path`");
      }
      break;
    }
    case "workspace_search_text": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("workspace_search_text requires non-empty string property `query`");
      }
      break;
    }
    case "workspace_write_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        errors.push("workspace_write_file requires non-empty string property `path`");
      }
      if (typeof args.content !== "string") {
        errors.push("workspace_write_file requires string property `content`");
      }
      break;
    }
    case "workspace_git_status":
      break;
    case "workspace_git_log":
      break;
    case "workspace_git_diff":
      break;
    case "workspace_git_commit": {
      if (typeof args.message !== "string" || !args.message.trim()) {
        errors.push("workspace_git_commit requires non-empty string property `message`");
      }
      if (!Array.isArray(args.paths) || args.paths.length === 0) {
        errors.push("workspace_git_commit requires non-empty array property `paths`");
      }
      break;
    }
    case "workspace_run_command": {
      if (!Array.isArray(args.argv) || args.argv.length === 0) {
        errors.push("workspace_run_command requires non-empty array property `argv`");
      } else if (!args.argv.every((x) => typeof x === "string")) {
        errors.push("workspace_run_command argv entries must be strings");
      }
      break;
    }
    case "browser_open_extract_text": {
      if (typeof args.url !== "string" || !args.url.trim()) {
        errors.push("browser_open_extract_text requires non-empty string property `url`");
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
