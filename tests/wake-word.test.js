import test from "node:test";
import assert from "node:assert/strict";

// --- DEFAULT_WAKE_WORDS ---

test("DEFAULT_WAKE_WORDS exports a non-empty array of strings", async () => {
  const { DEFAULT_WAKE_WORDS } = await import("../lib/wake-word.js");
  assert.ok(Array.isArray(DEFAULT_WAKE_WORDS));
  assert.ok(DEFAULT_WAKE_WORDS.length >= 3);
  for (const w of DEFAULT_WAKE_WORDS) assert.equal(typeof w, "string");
  assert.ok(DEFAULT_WAKE_WORDS.includes("hey siskelbot"));
});

// --- computeAudioFeatures ---

test("computeAudioFeatures returns zero features for empty input", async () => {
  const { computeAudioFeatures } = await import("../lib/wake-word.js");
  const f = computeAudioFeatures([]);
  assert.equal(f.rms, 0);
  assert.equal(f.zeroCrossings, 0);
  assert.equal(f.length, 0);
  assert.equal(f.peak, 0);
});

test("computeAudioFeatures computes RMS for a sine-like signal", async () => {
  const { computeAudioFeatures } = await import("../lib/wake-word.js");
  const samples = new Array(1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1);
  const f = computeAudioFeatures(samples);
  assert.ok(f.rms > 0);
  assert.ok(f.zeroCrossings > 10);
  assert.equal(f.length, 1000);
  assert.ok(f.peak > 0);
});

// --- createWakeWordDetector ---

test("createWakeWordDetector uses defaults when called with no options", async () => {
  const { createWakeWordDetector, DEFAULT_WAKE_WORDS } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  assert.deepEqual(d.getWakeWords(), DEFAULT_WAKE_WORDS);
  const stats = d.getStats();
  assert.equal(stats.detections, 0);
  assert.equal(stats.analyses, 0);
});

test("detector.analyze updates analysis count and returns score", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  const samples = new Array(2000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.05) * 0.5;
  const result = d.analyze(samples);
  assert.equal(typeof result.detected, "boolean");
  assert.equal(typeof result.score, "number");
  assert.equal(d.getStats().analyses, 1);
});

test("detector.analyze on silence does not detect", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector({ threshold: 0.7 });
  const silence = new Array(2000).fill(0);
  const result = d.analyze(silence);
  assert.equal(result.detected, false);
  assert.equal(d.getStats().detections, 0);
});

test("detector.analyzeTranscript matches the wake word at the start", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  const result = d.analyzeTranscript("hey siskelbot what is the weather");
  assert.equal(result.detected, true);
  assert.equal(result.word, "hey siskelbot");
  assert.ok(result.score >= 0.65);
  assert.equal(d.getStats().detections, 1);
});

test("detector.analyzeTranscript matches an exact wake word", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  const result = d.analyzeTranscript("hey siskelbot");
  assert.equal(result.detected, true);
  assert.equal(result.score, 1.0);
});

test("detector.analyzeTranscript ignores unrelated transcripts", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector({ threshold: 0.85 });
  const result = d.analyzeTranscript("the cat sat on the mat");
  assert.equal(result.detected, false);
});

test("detector.setWakeWords replaces the active list", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  d.setWakeWords(["computer", "robot"]);
  assert.deepEqual(d.getWakeWords(), ["computer", "robot"]);
  const result = d.analyzeTranscript("computer turn on the lights");
  assert.equal(result.detected, true);
  assert.equal(result.word, "computer");
});

test("detector.setWakeWords throws on non-array input", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  assert.throws(() => d.setWakeWords("not-an-array"), TypeError);
});

test("detector.setThreshold validates range", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  d.setThreshold(0.5);
  assert.throws(() => d.setThreshold(2), RangeError);
  assert.throws(() => d.setThreshold(-0.1), RangeError);
});

test("detector.recordFalsePositive increments stats", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  d.recordFalsePositive();
  d.recordFalsePositive();
  assert.equal(d.getStats().falsePositives, 2);
});

test("detector.reset clears stats", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  const d = createWakeWordDetector();
  d.analyzeTranscript("hey siskelbot");
  d.recordFalsePositive();
  d.reset();
  const stats = d.getStats();
  assert.equal(stats.detections, 0);
  assert.equal(stats.analyses, 0);
  assert.equal(stats.falsePositives, 0);
  assert.equal(stats.lastDetection, null);
});

test("detector fires onDetect callback when threshold met", async () => {
  const { createWakeWordDetector } = await import("../lib/wake-word.js");
  let fired = null;
  const d = createWakeWordDetector({
    onDetect: (det) => { fired = det; },
  });
  d.analyzeTranscript("hey siskelbot start a new chat");
  assert.ok(fired);
  assert.equal(fired.word, "hey siskelbot");
});

// --- parseVoiceCommand ---

test("parseVoiceCommand returns null action for empty transcripts", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("");
  assert.equal(result.action, null);
  assert.equal(result.confidence, 0);
});

test("parseVoiceCommand recognizes 'new chat'", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("new chat");
  assert.equal(result.action, "new_conversation");
  assert.ok(result.confidence > 0);
});

test("parseVoiceCommand strips wake word and recognizes 'new chat'", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("hey siskelbot new chat");
  assert.equal(result.action, "new_conversation");
});

test("parseVoiceCommand captures search query via wildcard", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("search for python tutorials");
  assert.equal(result.action, "search");
  assert.equal(result.params.query, "python tutorials");
});

test("parseVoiceCommand captures navigation destination slot", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("show recipes");
  assert.equal(result.action, "navigate");
  assert.equal(result.params.destination, "recipes");
});

test("parseVoiceCommand handles 'go to' navigation alias", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("go to settings");
  assert.equal(result.action, "navigate");
  assert.equal(result.params.destination, "settings");
});

test("parseVoiceCommand recognizes 'run recipe' with name slot", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("run recipe deploy");
  assert.equal(result.action, "run_recipe");
  assert.equal(result.params.name, "deploy");
});

test("parseVoiceCommand recognizes 'stop' as interrupt", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("stop");
  assert.equal(result.action, "interrupt");
});

test("parseVoiceCommand recognizes alternation in 'delete (last|this) message'", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const lastResult = parseVoiceCommand("delete last message");
  assert.equal(lastResult.action, "delete_message");
  assert.equal(lastResult.params.choice, "last");
  const thisResult = parseVoiceCommand("delete this message");
  assert.equal(thisResult.action, "delete_message");
  assert.equal(thisResult.params.choice, "this");
});

test("parseVoiceCommand returns null for unknown commands", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("brew me a cup of coffee");
  assert.equal(result.action, null);
});

test("parseVoiceCommand handles 'switch model to' with multi-word slot", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("switch model to gpt 4");
  assert.equal(result.action, "switch_model");
  assert.equal(result.params.name, "gpt 4");
});

test("parseVoiceCommand recognizes help intent", async () => {
  const { parseVoiceCommand } = await import("../lib/wake-word.js");
  const result = parseVoiceCommand("help");
  assert.equal(result.action, "help");
});

test("VOICE_COMMAND_GRAMMAR exposes patterns and actions", async () => {
  const { VOICE_COMMAND_GRAMMAR } = await import("../lib/wake-word.js");
  assert.ok(VOICE_COMMAND_GRAMMAR["new chat"]);
  assert.equal(VOICE_COMMAND_GRAMMAR["new chat"].action, "new_conversation");
  assert.ok(VOICE_COMMAND_GRAMMAR["search for *"]);
  assert.equal(VOICE_COMMAND_GRAMMAR["search for *"].action, "search");
});

test("stripWakeWord removes leading wake word", async () => {
  const { stripWakeWord } = await import("../lib/wake-word.js");
  assert.equal(stripWakeWord("hey siskelbot new chat"), "new chat");
  assert.equal(stripWakeWord("new chat"), "new chat");
  assert.equal(stripWakeWord("hey siskelbot"), "");
});
