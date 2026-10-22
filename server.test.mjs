import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, payloadFor, extractImages } from './server.mjs';
import { configFromEnv } from './config.mjs';

test('Responses uses GPT-4o with a required image generation tool', () => {
  const p = payloadFor({ prompt: 'a cat', history: ['a garden'] }, {});
  assert.equal(p.model, 'gpt-4o'); assert.equal(p.tool_choice.type, 'image_generation'); assert.match(p.input, /a garden/);
});
test('Images mode uses configured deployment and validates input', () => {
  assert.equal(payloadFor({ prompt: 'a cat' }, { API_MODE: 'images', MODEL: 'my-deployment' }).model, 'my-deployment');
  for (const body of [{ prompt: '' }, { prompt: 'x', size: 'bad' }, { prompt: 'x', history: 'bad' }, { prompt: 'x', quality: 'bad' }]) assert.throws(() => payloadFor(body));
});
test('parses both response formats and rejects insecure image links', () => {
  assert.equal(extractImages({ output: [{ type: 'image_generation_call', result: 'YWJj' }] })[0].src, 'data:image/png;base64,YWJj');
  assert.equal(extractImages({ data: [{ b64_json: 'YWJj' }, { url: 'https://example.com/img.png' }, { url: 'javascript:alert(1)' }] }).length, 2);
});
test('serves interface, protects secrets, and reports missing configuration', async () => {
  const server = createAppServer({ getConfig: () => configFromEnv({}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '//')).status, 400);
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/.env')).status, 404);
    const status = await (await fetch(base + '/api/status')).json(); assert.equal('API_KEY' in status, false);
    assert.equal((await fetch(base + '/api/generate', { method: 'POST', body: '{}' })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
