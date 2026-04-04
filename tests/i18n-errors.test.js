import test from "node:test";
import assert from "node:assert/strict";
import { getErrorMessage, detectLanguage, getSupportedLanguages } from "../lib/i18n-errors.js";

test("getErrorMessage returns English by default", () => {
  const msg = getErrorMessage("AUTH_REQUIRED");
  assert.equal(msg, "Authentication required");
});

test("getErrorMessage returns English explicitly", () => {
  const msg = getErrorMessage("NOT_FOUND", "en");
  assert.equal(msg, "Resource not found");
});

test("getErrorMessage returns Spanish for es", () => {
  const msg = getErrorMessage("AUTH_REQUIRED", "es");
  assert.equal(msg, "Autenticaci\u00f3n requerida");
});

test("getErrorMessage returns French for fr", () => {
  const msg = getErrorMessage("FORBIDDEN", "fr");
  assert.equal(msg, "Acc\u00e8s refus\u00e9");
});

test("getErrorMessage returns German for de", () => {
  const msg = getErrorMessage("RATE_LIMITED", "de");
  assert.equal(msg, "Zu viele Anfragen");
});

test("getErrorMessage falls back to English for unknown locale", () => {
  const msg = getErrorMessage("AUTH_REQUIRED", "xx");
  assert.equal(msg, "Authentication required");
});

test("getErrorMessage returns code when code is unknown", () => {
  const msg = getErrorMessage("TOTALLY_UNKNOWN_CODE", "en");
  assert.equal(msg, "TOTALLY_UNKNOWN_CODE");
});

test("getErrorMessage returns code for unknown code in unknown locale", () => {
  const msg = getErrorMessage("UNKNOWN_CODE_123", "zz");
  assert.equal(msg, "UNKNOWN_CODE_123");
});

test("detectLanguage parses Accept-Language header", () => {
  const lang = detectLanguage({
    headers: { "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" },
  });
  assert.equal(lang, "fr");
});

test("detectLanguage returns en for missing header", () => {
  const lang = detectLanguage({ headers: {} });
  assert.equal(lang, "en");
});

test("detectLanguage returns en for null request", () => {
  const lang = detectLanguage(null);
  assert.equal(lang, "en");
});

test("detectLanguage handles es-MX prefix match", () => {
  const lang = detectLanguage({
    headers: { "accept-language": "es-MX,es;q=0.9" },
  });
  assert.equal(lang, "es");
});

test("detectLanguage picks highest quality language", () => {
  const lang = detectLanguage({
    headers: { "accept-language": "ja;q=0.5,de;q=0.9,en;q=0.1" },
  });
  assert.equal(lang, "de");
});

test("detectLanguage falls back to en for unsupported languages", () => {
  const lang = detectLanguage({
    headers: { "accept-language": "zh-CN,zh;q=0.9" },
  });
  assert.equal(lang, "en");
});

test("getSupportedLanguages returns array with en, es, fr, de", () => {
  const langs = getSupportedLanguages();
  assert.ok(Array.isArray(langs));
  assert.ok(langs.includes("en"));
  assert.ok(langs.includes("es"));
  assert.ok(langs.includes("fr"));
  assert.ok(langs.includes("de"));
});
