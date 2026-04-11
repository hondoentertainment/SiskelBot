/**
 * Phase 70.2: High-contrast themes tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-hct-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  computeContrast,
  suggestPairs,
  listThemes,
  createTheme,
  getTheme,
  parseHex,
  relativeLuminance,
} = await import("../lib/high-contrast-themes.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("parseHex handles 3/4/6/8 char forms", () => {
  assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  assert.deepEqual(parseHex("000"), [0, 0, 0]);
  assert.deepEqual(parseHex("#336699"), [0x33, 0x66, 0x99]);
  assert.deepEqual(parseHex("336699AA"), [0x33, 0x66, 0x99]);
});

test("parseHex rejects invalid input", () => {
  assert.throws(() => parseHex(""));
  assert.throws(() => parseHex("zzz"));
  assert.throws(() => parseHex(null));
});

test("relativeLuminance is 0 for black and 1 for white", () => {
  assert.ok(Math.abs(relativeLuminance("#000000")) < 1e-6);
  assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-6);
});

test("computeContrast returns 21 for black/white (WCAG max)", () => {
  assert.equal(computeContrast("#000000", "#ffffff"), 21);
  assert.equal(computeContrast("#ffffff", "#000000"), 21);
});

test("computeContrast returns 1 for identical colors", () => {
  assert.equal(computeContrast("#777777", "#777777"), 1);
});

test("suggestPairs returns only WCAG-passing pairs", () => {
  const pairs = suggestPairs(["#000000", "#ffffff", "#888888"], { minRatio: 4.5 });
  assert.ok(pairs.length >= 2);
  assert.ok(pairs.every((p) => p.ratio >= 4.5));
  assert.ok(pairs.some((p) => p.grade === "AAA"));
});

test("suggestPairs returns [] when colors are too similar", () => {
  const pairs = suggestPairs(["#111111", "#222222"], { minRatio: 4.5 });
  assert.deepEqual(pairs, []);
});

test("suggestPairs handles empty or single-color input", () => {
  assert.deepEqual(suggestPairs([]), []);
  assert.deepEqual(suggestPairs(["#000"]), []);
});

test("createTheme persists a theme with computed ratios", async () => {
  const rec = await createTheme({
    id: "dark-hc",
    name: "Dark High Contrast",
    colors: { fg: "#ffffff", bg: "#000000", link: "#55aaff" },
    reducedMotion: true,
  });
  assert.equal(rec.id, "dark-hc");
  assert.equal(rec.ratios.fgBg, 21);
  assert.ok(rec.ratios.linkBg > 1);
  assert.equal(rec.reducedMotion, true);
});

test("createTheme rejects invalid colors", async () => {
  await assert.rejects(() => createTheme({ id: "bad", colors: { fg: "not-a-color" } }));
  await assert.rejects(() => createTheme(null));
  await assert.rejects(() => createTheme({ id: "", colors: {} }));
});

test("getTheme retrieves or returns null", async () => {
  await createTheme({ id: "t1", colors: { fg: "#fff", bg: "#000" } });
  const rec = await getTheme("t1");
  assert.ok(rec);
  assert.equal(rec.id, "t1");
  assert.equal(await getTheme("nope"), null);
});

test("listThemes returns every stored theme", async () => {
  await createTheme({ id: "t2", colors: { fg: "#fff", bg: "#000" } });
  const all = await listThemes();
  assert.ok(all.length >= 1);
});
