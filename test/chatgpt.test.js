/**
 * Tests for src/chatgpt.js — MODEL_ALIASES, setModel, getModels.
 * No browser required — tests only static methods.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const ChatGPTController = require('../src/chatgpt');

// We need an instance for setModel, but it doesn't touch the browser.
// Create a minimal stub that satisfies the constructor.
function makeStub() {
  const stubBrowser = { onResetSession: null };
  return new ChatGPTController(stubBrowser);
}

// ── MODEL_ALIASES ──────────────────────────────────────────────────

test('MODEL_ALIASES: gpt-5 aliases map correctly', () => {
  assert.strictEqual(ChatGPTController.MODEL_ALIASES['gpt-5'], 'gpt-5');
  assert.strictEqual(ChatGPTController.MODEL_ALIASES['gpt5'], 'gpt-5');
});

test('MODEL_ALIASES: o4-mini aliases map correctly', () => {
  assert.strictEqual(ChatGPTController.MODEL_ALIASES['o4-mini'], 'o4-mini');
  assert.strictEqual(ChatGPTController.MODEL_ALIASES['o4mini'], 'o4-mini');
});

test('MODEL_ALIASES: deep-research is supported', () => {
  assert.strictEqual(ChatGPTController.MODEL_ALIASES['deep-research'], 'deep-research');
});

// ── setModel ───────────────────────────────────────────────────────

test('setModel: sets valid model', () => {
  const c = makeStub();
  const result = c.setModel('gpt-5');
  assert.strictEqual(result, 'gpt-5');
  assert.strictEqual(c.currentModel, 'gpt-5');
});

test('setModel: accepts aliases', () => {
  const c = makeStub();
  c.setModel('gpt5');
  assert.strictEqual(c.currentModel, 'gpt-5');
  c.setModel('o4mini');
  assert.strictEqual(c.currentModel, 'o4-mini');
});

test('setModel: case-insensitive', () => {
  const c = makeStub();
  c.setModel('GPT-5');
  assert.strictEqual(c.currentModel, 'gpt-5');
  c.setModel('O4-MINI');
  assert.strictEqual(c.currentModel, 'o4-mini');
});

test('setModel: trims whitespace', () => {
  const c = makeStub();
  c.setModel('  gpt-5  ');
  assert.strictEqual(c.currentModel, 'gpt-5');
});

test('setModel: throws on unknown model', () => {
  const c = makeStub();
  assert.throws(() => c.setModel('gpt-99'), /Unknown model/);
});

test('setModel: throws on null/undefined', () => {
  const c = makeStub();
  assert.throws(() => c.setModel(null), /Unknown model/);
  assert.throws(() => c.setModel(undefined), /Unknown model/);
});

// ── getModels ──────────────────────────────────────────────────────

test('getModels: returns unique list of models', () => {
  const c = makeStub();
  const models = c.getModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  // Check uniqueness
  assert.strictEqual(models.length, new Set(models).size);
  // Should include known models
  assert.ok(models.includes('gpt-5'));
  assert.ok(models.includes('o3'));
  assert.ok(models.includes('o4-mini'));
});

// ── resetSession ───────────────────────────────────────────────────

test('resetSession: clears state', () => {
  const c = makeStub();
  c.currentSessionId = 'abc123';
  c.isBusy = true;
  c.state = { isThinking: true, isStreaming: true };
  c.resetSession();
  assert.strictEqual(c.currentSessionId, null);
  assert.strictEqual(c.isBusy, false);
  assert.deepStrictEqual(c.state, { isThinking: false, isStreaming: false });
});
