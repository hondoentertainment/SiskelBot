import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getBranding, setBranding, renderBrandedPage, DEFAULT_BRANDING } from "../lib/white-label.js";

function setupTmpDir() {
  return mkdtempSync(join(tmpdir(), "white-label-"));
}

test("getBranding returns defaults when no branding is configured", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const branding = await getBranding("workspace-1");
    assert.equal(branding.appName, "SiskelBot");
    assert.equal(branding.primaryColor, "#2563eb");
    assert.equal(branding.logoUrl, "/icon.svg");
    assert.equal(branding.faviconUrl, "");
    assert.equal(branding.customCss, "");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getBranding returns defaults for null/undefined workspaceId", async () => {
  const branding = await getBranding(null);
  assert.equal(branding.appName, DEFAULT_BRANDING.appName);
  assert.equal(branding.primaryColor, DEFAULT_BRANDING.primaryColor);

  const branding2 = await getBranding(undefined);
  assert.equal(branding2.appName, DEFAULT_BRANDING.appName);
});

test("setBranding persists and getBranding retrieves it", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const saved = await setBranding("ws-test", {
      appName: "My Custom App",
      primaryColor: "#ff5500",
      logoUrl: "https://example.com/logo.png",
      faviconUrl: "https://example.com/favicon.ico",
      customCss: "body { font-size: 16px; }",
    });
    assert.equal(saved.appName, "My Custom App");
    assert.equal(saved.primaryColor, "#ff5500");
    assert.equal(saved.logoUrl, "https://example.com/logo.png");
    assert.equal(saved.faviconUrl, "https://example.com/favicon.ico");
    assert.equal(saved.customCss, "body { font-size: 16px; }");

    // Retrieve it back
    const loaded = await getBranding("ws-test");
    assert.equal(loaded.appName, "My Custom App");
    assert.equal(loaded.primaryColor, "#ff5500");
    assert.equal(loaded.logoUrl, "https://example.com/logo.png");
    assert.equal(loaded.faviconUrl, "https://example.com/favicon.ico");
    assert.equal(loaded.customCss, "body { font-size: 16px; }");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setBranding falls back to defaults for missing/invalid fields", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const saved = await setBranding("ws-defaults", {});
    assert.equal(saved.appName, DEFAULT_BRANDING.appName);
    assert.equal(saved.primaryColor, DEFAULT_BRANDING.primaryColor);
    assert.equal(saved.logoUrl, DEFAULT_BRANDING.logoUrl);
    assert.equal(saved.faviconUrl, "");
    assert.equal(saved.customCss, "");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setBranding rejects invalid color values", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const saved = await setBranding("ws-color", {
      primaryColor: "not-a-color",
    });
    // Should fall back to default
    assert.equal(saved.primaryColor, DEFAULT_BRANDING.primaryColor);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setBranding sanitizes URLs", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const saved = await setBranding("ws-urls", {
      logoUrl: "javascript:alert(1)",
      faviconUrl: "/valid-path.ico",
    });
    // javascript: scheme should be rejected, falling back to default
    assert.equal(saved.logoUrl, DEFAULT_BRANDING.logoUrl);
    // Relative path should be accepted
    assert.equal(saved.faviconUrl, "/valid-path.ico");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setBranding throws for missing workspaceId", async () => {
  await assert.rejects(
    () => setBranding(null, { appName: "Test" }),
    { message: "workspaceId is required" }
  );
});

test("setBranding throws for missing branding object", async () => {
  await assert.rejects(
    () => setBranding("ws-1", null),
    { message: "branding object is required" }
  );
});

test("setBranding truncates long appName", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const longName = "A".repeat(200);
    const saved = await setBranding("ws-long", { appName: longName });
    assert.equal(saved.appName.length, 100);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderBrandedPage replaces all placeholders", () => {
  const template = `
    <title>{{appName}}</title>
    <link rel="icon" href="{{faviconUrl}}">
    <img src="{{logoUrl}}">
    <style>:root { --primary: {{primaryColor}}; } {{customCss}}</style>
  `;
  const branding = {
    appName: "My App",
    logoUrl: "/my-logo.svg",
    primaryColor: "#ff0000",
    faviconUrl: "/my-favicon.ico",
    customCss: "body { color: red; }",
  };
  const result = renderBrandedPage(template, branding);
  assert.ok(result.includes("My App"));
  assert.ok(result.includes("/my-logo.svg"));
  assert.ok(result.includes("#ff0000"));
  assert.ok(result.includes("/my-favicon.ico"));
  assert.ok(result.includes("body { color: red; }"));
  assert.ok(!result.includes("{{appName}}"));
  assert.ok(!result.includes("{{logoUrl}}"));
  assert.ok(!result.includes("{{primaryColor}}"));
  assert.ok(!result.includes("{{faviconUrl}}"));
  assert.ok(!result.includes("{{customCss}}"));
});

test("renderBrandedPage escapes HTML in appName", () => {
  const template = "<h1>{{appName}}</h1>";
  const branding = { appName: '<script>alert("xss")</script>' };
  const result = renderBrandedPage(template, branding);
  assert.ok(!result.includes("<script>"));
  assert.ok(result.includes("&lt;script&gt;"));
});

test("renderBrandedPage handles multiple occurrences", () => {
  const template = "{{appName}} - {{appName}} - {{appName}}";
  const branding = { appName: "Test" };
  const result = renderBrandedPage(template, branding);
  assert.equal(result, "Test - Test - Test");
});

test("renderBrandedPage uses defaults for missing branding fields", () => {
  const template = "{{appName}} {{primaryColor}}";
  const result = renderBrandedPage(template, {});
  assert.ok(result.includes(DEFAULT_BRANDING.appName));
  assert.ok(result.includes(DEFAULT_BRANDING.primaryColor));
});

test("renderBrandedPage returns empty string for non-string template", () => {
  const result = renderBrandedPage(null, { appName: "Test" });
  assert.equal(result, "");
});

test("renderBrandedPage handles null branding gracefully", () => {
  const template = "{{appName}}";
  const result = renderBrandedPage(template, null);
  assert.ok(result.includes(DEFAULT_BRANDING.appName));
});
