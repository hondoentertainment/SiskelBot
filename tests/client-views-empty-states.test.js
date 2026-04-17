/**
 * Unit tests for client/src/views/empty-states.js.
 *
 * The module is pure (no DOM side-effects) so it can be tested
 * without JSDOM.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { renderEmptyState } = await import(
  "../client/src/views/empty-states.js"
);

// ── chat ────────────────────────────────────────────────────────────────────

test('renderEmptyState("chat") contains "Start your first conversation"', () => {
  const html = renderEmptyState("chat");
  assert.ok(html.includes("Start your first conversation"), "expected chat title");
});

test('renderEmptyState("chat") contains a .es-cta button with "New Chat"', () => {
  const html = renderEmptyState("chat");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
  assert.ok(html.includes("New Chat"), "expected CTA label");
});

// ── runs ────────────────────────────────────────────────────────────────────

test('renderEmptyState("runs") contains "No agent runs"', () => {
  const html = renderEmptyState("runs");
  assert.ok(html.includes("No agent runs"), "expected runs title");
});

test('renderEmptyState("runs") contains a .es-cta button', () => {
  const html = renderEmptyState("runs");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
  assert.ok(html.includes("Start a Run"), "expected CTA label");
});

// ── knowledge ───────────────────────────────────────────────────────────────

test('renderEmptyState("knowledge") contains "knowledge base is empty"', () => {
  const html = renderEmptyState("knowledge");
  assert.ok(html.includes("knowledge base is empty"), "expected knowledge title");
});

test('renderEmptyState("knowledge") contains a .es-cta button', () => {
  const html = renderEmptyState("knowledge");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
  assert.ok(html.includes("Add Document"), "expected CTA label");
});

// ── recipes ─────────────────────────────────────────────────────────────────

test('renderEmptyState("recipes") contains "No recipes"', () => {
  const html = renderEmptyState("recipes");
  assert.ok(html.includes("No recipes"), "expected recipes title");
});

test('renderEmptyState("recipes") contains a .es-cta button', () => {
  const html = renderEmptyState("recipes");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
  assert.ok(html.includes("New Recipe"), "expected CTA label");
});

// ── default ─────────────────────────────────────────────────────────────────

test('renderEmptyState("default") contains "Nothing here yet"', () => {
  const html = renderEmptyState("default");
  assert.ok(html.includes("Nothing here yet"), "expected default title");
});

test('renderEmptyState("default") contains a .es-cta button', () => {
  const html = renderEmptyState("default");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
});

// ── unknown type falls back to default ──────────────────────────────────────

test("renderEmptyState with unknown type falls back to default", () => {
  const html = renderEmptyState("nonexistent");
  assert.ok(html.includes("Nothing here yet"), "expected default fallback");
  assert.ok(html.includes('class="es-cta"'), "expected .es-cta class");
});

// ── structural checks ──────────────────────────────────────────────────────

test("all types include .es-empty wrapper, .es-icon, .es-title, .es-desc, .es-cta", () => {
  for (const type of ["chat", "runs", "knowledge", "recipes", "default"]) {
    const html = renderEmptyState(type);
    assert.ok(html.includes('class="es-empty"'), `${type}: missing .es-empty`);
    assert.ok(html.includes('class="es-icon"'), `${type}: missing .es-icon`);
    assert.ok(html.includes('class="es-title"'), `${type}: missing .es-title`);
    assert.ok(html.includes('class="es-desc"'), `${type}: missing .es-desc`);
    assert.ok(html.includes('class="es-cta"'), `${type}: missing .es-cta`);
  }
});

test("all types include an inline SVG icon", () => {
  for (const type of ["chat", "runs", "knowledge", "recipes", "default"]) {
    const html = renderEmptyState(type);
    assert.ok(html.includes("<svg"), `${type}: missing SVG icon`);
    assert.ok(html.includes("</svg>"), `${type}: missing closing SVG tag`);
  }
});
