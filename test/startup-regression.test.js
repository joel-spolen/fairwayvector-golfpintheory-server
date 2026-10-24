import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigurationError } from '../src/config.js';

test('invalid configuration has an explicitly safe error type without exposing values', () => {
  const secret = 'short-secret';
  assert.throws(() => loadConfig({ SERVER_API_TOKEN: secret }), error => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /SERVER_API_TOKEN/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('startup explains a missing token without opening a database or printing secrets', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: { SERVER_API_TOKEN: 'short-secret', GOLF_API_KEY: 'private-provider-key' }, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Server configuration error: SERVER_API_TOKEN/);
  assert.ok(!result.stderr.includes('short-secret'));
  assert.ok(!result.stderr.includes('private-provider-key'));
  assert.ok(!result.stderr.includes('Server startup failed.'));
});