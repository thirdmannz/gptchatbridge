/**
 * Tests for src/agent.js — parseToolCalls, stripToolBlocks, formatToolResult.
 * No browser required. Uses Node's built-in test runner.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { parseToolCalls, stripToolBlocks } = require('../src/agent');

// ── parseToolCalls ─────────────────────────────────────────────────

test('parseToolCalls: extracts a single tool call', () => {
  const text = 'Let me read that file.\n```tool\n{"tool":"read_file","args":{"path":"src/index.js"}}\n```\nDone.';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tool, 'read_file');
  assert.deepStrictEqual(calls[0].args, { path: 'src/index.js' });
});

test('parseToolCalls: extracts multiple tool calls', () => {
  const text = '```tool\n{"tool":"read_file","args":{"path":"a.js"}}\n```\nNow run:\n```tool\n{"tool":"run","args":{"cmd":"npm test"}}\n```';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].tool, 'read_file');
  assert.strictEqual(calls[1].tool, 'run');
  assert.strictEqual(calls[1].args.cmd, 'npm test');
});

test('parseToolCalls: returns empty for no tool blocks', () => {
  assert.strictEqual(parseToolCalls('Just a normal reply.').length, 0);
  assert.strictEqual(parseToolCalls('').length, 0);
});

test('parseToolCalls: ignores malformed JSON in tool block', () => {
  const text = '```tool\n{not valid json}\n```';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 0);
});

test('parseToolCalls: handles tool call with no args', () => {
  const text = '```tool\n{"tool":"list_dir"}\n```';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tool, 'list_dir');
  assert.deepStrictEqual(calls[0].args, {});
});

test('parseToolCalls: handles multi-line JSON in tool block', () => {
  const text = '```tool\n{\n  "tool": "write_file",\n  "args": {\n    "path": "out.txt",\n    "content": "hello"\n  }\n}\n```';
  const calls = parseToolCalls(text);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tool, 'write_file');
  assert.strictEqual(calls[0].args.content, 'hello');
});

// ── stripToolBlocks ────────────────────────────────────────────────

test('stripToolBlocks: removes tool blocks, keeps rest', () => {
  const text = 'Here is my plan.\n```tool\n{"tool":"read_file","args":{"path":"a.js"}}\n```\nNow I will proceed.';
  const result = stripToolBlocks(text);
  // The tool block line is removed but the surrounding newlines remain
  assert.strictEqual(result, 'Here is my plan.\n\nNow I will proceed.');
});

test('stripToolBlocks: returns text unchanged if no tool blocks', () => {
  assert.strictEqual(stripToolBlocks('Just text.'), 'Just text.');
});

test('stripToolBlocks: handles empty string', () => {
  assert.strictEqual(stripToolBlocks(''), '');
});

test('stripToolBlocks: removes multiple tool blocks', () => {
  const text = '```tool\n{"tool":"a"}\n```\nmiddle\n```tool\n{"tool":"b"}\n```';
  const result = stripToolBlocks(text);
  assert.strictEqual(result, 'middle');
});
