import test from "node:test";
import assert from "node:assert/strict";
import { validate, sanitizeString, sanitizeId, sanitizeWorkspaceId } from "../lib/validate.js";

function mockReqRes(body = {}, query = {}, params = {}) {
  const req = { body, query, params };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(obj) {
      jsonBody = obj;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

test("validate: required field missing returns 400", () => {
  const mw = validate({ body: { name: "string" } });
  const { req, res, getStatus, getJson } = mockReqRes({});
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().code, "VALIDATION_ERROR");
  assert.equal(getJson().details.length, 1);
  assert.match(getJson().details[0].message, /name is required/);
});

test("validate: wrong type returns 400", () => {
  const mw = validate({ body: { count: "number" } });
  const { req, res, getStatus, getJson } = mockReqRes({ count: "not-a-number" });
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(getStatus(), 400);
  assert.equal(getJson().code, "VALIDATION_ERROR");
  assert.match(getJson().details[0].message, /count must be of type number/);
});

test("validate: optional field missing passes", () => {
  const mw = validate({ body: { name: "string", bio: "?string" } });
  const { req, res } = mockReqRes({ name: "alice" });
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("validate: valid body passes", () => {
  const mw = validate({ body: { messages: "array", model: "?string", stream: "?boolean" } });
  const { req, res } = mockReqRes({ messages: [{ role: "user", content: "hi" }], model: "gpt-4" });
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("validate: nested schema validation", () => {
  const mw = validate({ body: { options: { model: "string", temperature: "?number" } } });

  // Missing nested required field
  const { req: r1, res: res1, getStatus: s1, getJson: j1 } = mockReqRes({ options: {} });
  let c1 = false;
  mw(r1, res1, () => { c1 = true; });
  assert.equal(c1, false);
  assert.equal(s1(), 400);
  assert.match(j1().details[0].message, /options\.model is required/);

  // Valid nested
  const { req: r2, res: res2 } = mockReqRes({ options: { model: "gpt-4" } });
  let c2 = false;
  mw(r2, res2, () => { c2 = true; });
  assert.equal(c2, true);
});

test("validate: nested object missing entirely with required children returns 400", () => {
  const mw = validate({ body: { options: { model: "string" } } });
  const { req, res, getStatus, getJson } = mockReqRes({});
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(getStatus(), 400);
  assert.match(getJson().details[0].message, /options is required/);
});

test("validate: nested object missing with all-optional children passes", () => {
  const mw = validate({ body: { options: { model: "?string" } } });
  const { req, res } = mockReqRes({});
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("validate: email type", () => {
  const mw = validate({ body: { email: "email" } });

  const { req: r1, res: res1, getStatus: s1 } = mockReqRes({ email: "bad" });
  let c1 = false;
  mw(r1, res1, () => { c1 = true; });
  assert.equal(c1, false);
  assert.equal(s1(), 400);

  const { req: r2, res: res2 } = mockReqRes({ email: "a@b.com" });
  let c2 = false;
  mw(r2, res2, () => { c2 = true; });
  assert.equal(c2, true);
});

test("validate: query and params validation", () => {
  const mw = validate({ query: { page: "?string" }, params: { id: "string" } });
  const { req, res, getStatus, getJson } = mockReqRes({}, { page: "1" }, {});
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(getStatus(), 400);
  assert.match(getJson().details[0].message, /id is required/);
});

test("validate: multiple errors returned", () => {
  const mw = validate({ body: { name: "string", age: "number" } });
  const { req, res, getJson } = mockReqRes({});
  mw(req, res, () => {});
  assert.equal(getJson().details.length, 2);
});

test("validate: boolean type check", () => {
  const mw = validate({ body: { active: "boolean" } });
  const { req, res } = mockReqRes({ active: true });
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test("validate: object type check", () => {
  const mw = validate({ body: { meta: "object" } });

  // Array should not pass as object
  const { req: r1, res: res1, getStatus: s1 } = mockReqRes({ meta: [] });
  let c1 = false;
  mw(r1, res1, () => { c1 = true; });
  assert.equal(c1, false);
  assert.equal(s1(), 400);

  // Valid object
  const { req: r2, res: res2 } = mockReqRes({ meta: { foo: "bar" } });
  let c2 = false;
  mw(r2, res2, () => { c2 = true; });
  assert.equal(c2, true);
});

// --- sanitizeString ---

test("sanitizeString: truncates to maxLength", () => {
  const result = sanitizeString("abcdefgh", 5);
  assert.equal(result, "abcde");
});

test("sanitizeString: trims whitespace", () => {
  const result = sanitizeString("  hello  ");
  assert.equal(result, "hello");
});

test("sanitizeString: strips control characters", () => {
  const result = sanitizeString("hello\x00world\x1F");
  assert.equal(result, "helloworld");
});

test("sanitizeString: returns empty string for non-string", () => {
  assert.equal(sanitizeString(42), "");
  assert.equal(sanitizeString(null), "");
  assert.equal(sanitizeString(undefined), "");
});

// --- sanitizeId ---

test("sanitizeId: accepts valid id", () => {
  assert.equal(sanitizeId("my-workspace_01"), "my-workspace_01");
});

test("sanitizeId: rejects special characters", () => {
  assert.equal(sanitizeId("foo bar"), "");
  assert.equal(sanitizeId("foo@bar"), "");
  assert.equal(sanitizeId("../etc/passwd"), "");
  assert.equal(sanitizeId("<script>"), "");
});

test("sanitizeId: truncates to 100 chars", () => {
  const long = "a".repeat(150);
  const result = sanitizeId(long);
  assert.equal(result.length, 100);
});

test("sanitizeId: returns empty for non-string", () => {
  assert.equal(sanitizeId(123), "");
  assert.equal(sanitizeId(null), "");
});

// --- sanitizeWorkspaceId ---

test("sanitizeWorkspaceId: returns default for invalid", () => {
  assert.equal(sanitizeWorkspaceId("foo bar"), "default");
  assert.equal(sanitizeWorkspaceId(""), "default");
  assert.equal(sanitizeWorkspaceId(null), "default");
});

test("sanitizeWorkspaceId: returns valid id", () => {
  assert.equal(sanitizeWorkspaceId("my-workspace"), "my-workspace");
});
