import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configFromEnv, readConfig } from './config.mjs';
import { createAppServer } from './server.mjs';

const base = { API_KEY: 'test-key', API_ENDPOINT: 'https://test.services.ai.azure.com/openai/v1', DEPLOYMENT: 'gpt-4o', API_VERSION: '2024-10-21', PORT: '3000' };
test('Azure base endpoint gets the Chat Completions route and plain api-key authentication', () => {
  const config = configFromEnv(base);
  assert.equal(config.endpoint.href, 'https://test.services.ai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
  assert.equal(config.headers['api-key'], 'test-key');
  assert.equal(config.outputFormat, 'svg');
});
test('root endpoints, full routes and legacy Azure deployment queries remain valid', () => {
  assert.equal(configFromEnv({ ...base, API_ENDPOINT: 'https://test.openai.azure.com/' }).endpoint.pathname, '/openai/deployments/gpt-4o/chat/completions');
  const url = 'https://test.openai.azure.com/openai/deployments/my-model/chat/completions?api-version=2024-10-21';
  assert.equal(configFromEnv({ ...base, DEPLOYMENT: 'my-model', API_ENDPOINT: url }).endpoint.href, url);
  assert.equal(configFromEnv({ ...base, API_VERSION: '2025-01-01-preview' }).endpoint.searchParams.get('api-version'), '2025-01-01-preview');
});
test('configuration requires deployment and version and rejects unsafe URLs', () => {
  assert.throws(() => configFromEnv({ ...base, DEPLOYMENT: '' }), /DEPLOYMENT/);
  assert.throws(() => configFromEnv({ ...base, API_VERSION: '' }), /API_VERSION/);
  assert.throws(() => configFromEnv({ ...base, API_ENDPOINT: 'ftp://localhost/file' }), /HTTPS/);
  assert.throws(() => configFromEnv({ ...base, API_ENDPOINT: 'https://user:secret@example.com' }), /credentials/);
});
test('corrected local credentials override stale startup values on the next request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-config-')); const file = join(dir, '.env');
  try {
    const env = { ...base, API_KEY: 'stale-key' };
    writeFileSync(file, `API_KEY=fresh-key\nAPI_ENDPOINT=${base.API_ENDPOINT}\n`);
    assert.equal(readConfig({ env, file }).key, 'fresh-key');
    assert.equal(readConfig({ env, file }).mode, 'chat_completions');
    writeFileSync(file, `API_KEY=updated-key\nAPI_ENDPOINT=${base.API_ENDPOINT}\n`);
    assert.equal(readConfig({ env, file }).key, 'updated-key');
  } finally { rmSync(dir, { recursive: true }); }
});
test('provider authentication failures preserve HTTP 401 and redact the key', async () => {
  const config = configFromEnv(base);
  const server = createAppServer({ getConfig: () => config, providerFetch: async (url, init) => {
    assert.equal(url.pathname, '/openai/deployments/gpt-4o/chat/completions'); assert.equal(init.headers['api-key'], base.API_KEY);
    return new Response(JSON.stringify({ error: { message: 'Invalid key: ' + base.API_KEY } }), { status: 401 });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(url + '/api/generate', { method: 'POST', body: JSON.stringify({ prompt: 'A dog' }) });
    assert.equal(response.status, 401);
    const body = await response.text(); assert.doesNotMatch(body, /test-key/); assert.match(body, /redacted/);
    const status = await (await fetch(url + '/api/status')).json(); assert.equal(status.mode, 'chat_completions'); assert.equal('key' in status, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
