/**
 * Phase 55: Tool argument validation (pre-execution).
 * Phase 53.5: JSON Schema validation + schema-guided repair.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateToolCall,
  validate,
  validateType,
  validateString,
  validateNumber,
  validateArray,
  validateObject,
  repair,
  extractJson,
  repairJson,
  autoRepairToolCall,
  formatErrors,
  recordValidationEvent,
  getValidationStats,
  _resetValidationStats,
} from "../lib/tool-validation.js";

test("search_context requires non-empty query", () => {
  const v = validateToolCall("search_context", {});
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("query")));
});

test("execute_step requires action string", () => {
  const v = validateToolCall("execute_step", { payload: {} });
  assert.equal(v.valid, false);
});

test("list_context accepts empty object", () => {
  const v = validateToolCall("list_context", {});
  assert.equal(v.valid, true);
});

test("unknown tool fails", () => {
  const v = validateToolCall("bad_tool", {});
  assert.equal(v.valid, false);
});

test("parseError surfaces JSON hint", () => {
  const v = validateToolCall("search_context", {}, { parseError: "Unexpected token" });
  assert.equal(v.valid, false);
  assert.ok(v.repairHint.includes("JSON"));
});

test("semantic_search_context requires query", () => {
  const v = validateToolCall("semantic_search_context", {});
  assert.equal(v.valid, false);
});

test("get_context_document requires id", () => {
  const v = validateToolCall("get_context_document", { id: "" });
  assert.equal(v.valid, false);
});

test("list_recipes accepts empty object", () => {
  const v = validateToolCall("list_recipes", {});
  assert.equal(v.valid, true);
});

test("get_recipe requires name", () => {
  const v = validateToolCall("get_recipe", {});
  assert.equal(v.valid, false);
});

test("update_agent_session_plan requires planSummary or planDag", () => {
  assert.equal(validateToolCall("update_agent_session_plan", {}).valid, false);
  assert.equal(validateToolCall("update_agent_session_plan", { planSummary: "x" }).valid, true);
  assert.equal(validateToolCall("update_agent_session_plan", { planDag: { a: 1 } }).valid, true);
});

test("update_agent_session_plan rejects non-object planDag", () => {
  const v = validateToolCall("update_agent_session_plan", { planDag: [] });
  assert.equal(v.valid, false);
});

// -----------------------------------------------------------------------------
// Phase 53.5 — JSON schema validation + repair
// -----------------------------------------------------------------------------

test("validate: object with required fields succeeds", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  };
  const result = validate(schema, { name: "Alice", age: 30 });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validate: missing required field reports error", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  const result = validate(schema, {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /required/.test(e.message)));
});

test("validate: rejects additional properties when additionalProperties=false", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  const result = validate(schema, { name: "x", extra: 1 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /additional/.test(e.message)));
});

test("validateType: detects type mismatch for each primitive", () => {
  assert.equal(validateType({ type: "string" }, 42).length, 1);
  assert.equal(validateType({ type: "number" }, "x").length, 1);
  assert.equal(validateType({ type: "boolean" }, 1).length, 1);
  assert.equal(validateType({ type: "integer" }, 1.5).length, 1);
  assert.equal(validateType({ type: "array" }, {}).length, 1);
  assert.equal(validateType({ type: "object" }, []).length, 1);
  assert.equal(validateType({ type: "null" }, 0).length, 1);
  assert.equal(validateType({ type: "string" }, "ok").length, 0);
  assert.equal(validateType({ type: "integer" }, 5).length, 0);
});

test("validateString: minLength/maxLength/pattern", () => {
  assert.equal(validateString({ minLength: 3 }, "ab").length, 1);
  assert.equal(validateString({ maxLength: 2 }, "abcd").length, 1);
  assert.equal(validateString({ pattern: "^[a-z]+$" }, "ABC").length, 1);
  assert.equal(validateString({ minLength: 1, maxLength: 5, pattern: "^[a-z]+$" }, "abc").length, 0);
});

test("validateNumber: minimum/maximum/multipleOf", () => {
  assert.equal(validateNumber({ minimum: 10 }, 5).length, 1);
  assert.equal(validateNumber({ maximum: 10 }, 15).length, 1);
  assert.equal(validateNumber({ multipleOf: 3 }, 10).length, 1);
  assert.equal(validateNumber({ multipleOf: 3, minimum: 3, maximum: 12 }, 9).length, 0);
});

test("validateArray: minItems/maxItems/uniqueItems", () => {
  assert.equal(validateArray({ minItems: 2 }, [1]).length, 1);
  assert.equal(validateArray({ maxItems: 2 }, [1, 2, 3]).length, 1);
  assert.equal(validateArray({ uniqueItems: true }, [1, 1, 2]).length, 1);
  assert.equal(validateArray({ minItems: 1, maxItems: 3, uniqueItems: true }, [1, 2, 3]).length, 0);
});

test("validateObject: reports missing required and extra properties", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const errors = validateObject(schema, { b: 1 });
  assert.ok(errors.some((e) => /required/.test(e.message)));
  assert.ok(errors.some((e) => /additional/.test(e.message)));
});

test("repair: coerces string \"42\" to number 42", () => {
  const schema = { type: "number" };
  const { repaired, repairs } = repair(schema, "42");
  assert.equal(repaired, 42);
  assert.ok(repairs.some((r) => r.action === "coerce-number"));
});

test("repair: coerces string \"true\" to boolean true", () => {
  const schema = { type: "boolean" };
  const { repaired, repairs } = repair(schema, "true");
  assert.equal(repaired, true);
  assert.ok(repairs.some((r) => r.action === "coerce-boolean"));
});

test("repair: fills default values for missing properties", () => {
  const schema = {
    type: "object",
    properties: {
      verbose: { type: "boolean", default: false },
      limit: { type: "integer", default: 10 },
      name: { type: "string" },
    },
  };
  const { repaired, repairs } = repair(schema, { name: "x" });
  assert.equal(repaired.verbose, false);
  assert.equal(repaired.limit, 10);
  assert.ok(repairs.some((r) => r.action === "fill-default"));
});

test("repair: removes extra properties when additionalProperties=false", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  const { repaired, repairs } = repair(schema, { name: "x", extra: 1 });
  assert.deepEqual(repaired, { name: "x" });
  assert.ok(repairs.some((r) => r.action === "remove-additional"));
});

test("repair: trims strings exceeding maxLength", () => {
  const schema = { type: "string", maxLength: 5 };
  const { repaired, repairs } = repair(schema, "abcdefghij");
  assert.equal(repaired, "abcde");
  assert.ok(repairs.some((r) => r.action === "trim-maxLength"));
});

test("repair: parses JSON string when object expected", () => {
  const schema = { type: "object", properties: { a: { type: "number" } } };
  const { repaired, repairs } = repair(schema, '{"a": 1}');
  assert.deepEqual(repaired, { a: 1 });
  assert.ok(repairs.some((r) => r.action === "parse-json"));
});

test("repair: clamps number to schema minimum/maximum", () => {
  const schema = { type: "number", minimum: 0, maximum: 10 };
  const { repaired, repairs } = repair(schema, 99);
  assert.equal(repaired, 10);
  assert.ok(repairs.some((r) => r.action === "clamp-max"));
});

test("extractJson: from markdown code block", () => {
  const text = "Here is the output:\n```json\n{\"foo\": 1}\n```\nDone.";
  const value = extractJson(text);
  assert.deepEqual(value, { foo: 1 });
});

test("extractJson: from free text prose", () => {
  const text = "The answer is {\"answer\": 42} based on the analysis.";
  const value = extractJson(text);
  assert.deepEqual(value, { answer: 42 });
});

test("extractJson: returns null when no JSON present", () => {
  assert.equal(extractJson("just some prose"), null);
});

test("repairJson: strips trailing commas", () => {
  const repaired = repairJson('{"a": 1, "b": 2,}');
  assert.deepEqual(JSON.parse(repaired), { a: 1, b: 2 });
});

test("repairJson: converts single quotes to double", () => {
  const repaired = repairJson("{'a': 'hello'}");
  assert.deepEqual(JSON.parse(repaired), { a: "hello" });
});

test("repairJson: quotes unquoted object keys", () => {
  const repaired = repairJson("{foo: 1, bar: 2}");
  assert.deepEqual(JSON.parse(repaired), { foo: 1, bar: 2 });
});

test("repairJson: converts Python-style None/True/False", () => {
  const repaired = repairJson("{'a': None, 'b': True, 'c': False}");
  assert.deepEqual(JSON.parse(repaired), { a: null, b: true, c: false });
});

test("validateToolCall (schema mode): valid call", () => {
  const toolSchema = {
    name: "add",
    parameters: {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
  };
  const result = validateToolCall(toolSchema, { name: "add", arguments: { a: 1, b: 2 } });
  assert.equal(result.valid, true);
});

test("validateToolCall (schema mode): invalid args", () => {
  const toolSchema = {
    name: "add",
    parameters: {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
  };
  const result = validateToolCall(toolSchema, { name: "add", arguments: { a: 1 } });
  assert.equal(result.valid, false);
  assert.ok(Array.isArray(result.errors));
});

test("validateToolCall (schema mode): parses stringified arguments", () => {
  const toolSchema = {
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  };
  const result = validateToolCall(toolSchema, { name: "search", arguments: '{"q":"hi"}' });
  assert.equal(result.valid, true);
});

test("autoRepairToolCall: extracts JSON and validates", () => {
  const toolSchema = {
    parameters: {
      type: "object",
      required: ["q"],
      properties: { q: { type: "string" }, limit: { type: "integer", default: 10 } },
    },
  };
  const call = { name: "search", arguments: "```json\n{q: 'hi',}\n```" };
  const result = autoRepairToolCall(toolSchema, call);
  assert.equal(result.valid, true);
  assert.equal(result.repaired.arguments.q, "hi");
  assert.equal(result.repaired.arguments.limit, 10);
  assert.ok(result.repairs.length >= 1);
});

test("autoRepairToolCall: coerces types within args", () => {
  const toolSchema = {
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" }, enabled: { type: "boolean" } },
      required: ["limit"],
    },
  };
  const result = autoRepairToolCall(toolSchema, { arguments: { limit: "5", enabled: "false" } });
  assert.equal(result.valid, true);
  assert.equal(result.repaired.arguments.limit, 5);
  assert.equal(result.repaired.arguments.enabled, false);
});

test("formatErrors: text output", () => {
  const text = formatErrors([
    { path: "a", message: "too short" },
    { path: "b", message: "not a number" },
  ]);
  assert.ok(text.includes("a:"));
  assert.ok(text.includes("b:"));
});

test("formatErrors: JSON output", () => {
  const json = formatErrors([{ path: "a", message: "bad" }], "json");
  assert.deepEqual(JSON.parse(json), [{ path: "a", message: "bad" }]);
});

test("recordValidationEvent + getValidationStats aggregates", async () => {
  _resetValidationStats();
  await recordValidationEvent({ valid: true, toolName: "search" });
  await recordValidationEvent({ valid: false, toolName: "search", errorCount: 1, repaired: true });
  const stats = await getValidationStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.valid, 1);
  assert.equal(stats.invalid, 1);
  assert.equal(stats.repaired, 1);
  assert.equal(stats.byTool.search.total, 2);
});
