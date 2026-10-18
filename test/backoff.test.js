const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDelaySeconds } = require('../src/backoff');

test('delay grows with each attempt', () => {
  // jitter is +-25%, so compare with some room
  assert.ok(retryDelaySeconds(1) <= 2 * 1.25);
  assert.ok(retryDelaySeconds(3) >= 8 * 0.75);
  assert.ok(retryDelaySeconds(3) > retryDelaySeconds(1));
});

test('delay is capped', () => {
  assert.ok(retryDelaySeconds(20) <= 60 * 1.25);
});
