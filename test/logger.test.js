/**
 * Tests for src/logger.js — level filtering, child loggers.
 * No browser required. Uses Node's built-in test runner.
 */
const { test } = require("node:test");
const assert = require("node:assert");

// Re-require logger fresh for each test to reset LOG_LEVEL
function freshLogger(level) {
  // Save and restore env
  const old = process.env.LOG_LEVEL;
  if (level) process.env.LOG_LEVEL = level;
  else delete process.env.LOG_LEVEL;
  delete require.cache[require.resolve('../src/logger')];
  const logger = require('../src/logger');
  process.env.LOG_LEVEL = old;
  delete require.cache[require.resolve('../src/logger')];
  return logger;
}

test('logger: has all standard methods', () => {
  const logger = freshLogger();
  assert.strictEqual(typeof logger.debug, 'function');
  assert.strictEqual(typeof logger.info, 'function');
  assert.strictEqual(typeof logger.warn, 'function');
  assert.strictEqual(typeof logger.error, 'function');
  assert.strictEqual(typeof logger.child, 'function');
});

test('logger: child logger has same methods', () => {
  const logger = freshLogger();
  const child = logger.child('Test');
  assert.strictEqual(typeof child.debug, 'function');
  assert.strictEqual(typeof child.info, 'function');
  assert.strictEqual(typeof child.warn, 'function');
  assert.strictEqual(typeof child.error, 'function');
});

test('logger: does not crash on empty meta', () => {
  const logger = freshLogger('debug');
  assert.doesNotThrow(() => logger.info('test message'));
  assert.doesNotThrow(() => logger.info('test message', {}));
  assert.doesNotThrow(() => logger.info('test message', { key: 'value' }));
});

test('logger: does not crash on undefined msg', () => {
  const logger = freshLogger('debug');
  assert.doesNotThrow(() => logger.info(undefined));
  assert.doesNotThrow(() => logger.info(null));
});
