import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sanitizeSvg, svgFromCompletion, illustrationFromCompletion } from './svg.mjs';
import { payloadFor, createAppServer } from './server.mjs';
import { configFromEnv } from './config.mjs';

const drawing = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><title>A dog</title><circle cx="512" cy="512" r="150" fill="#c08040"/></svg>';
const completion = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });

test('Chat Completions requests drawing code from the configured GPT-4o deployment', () => {
  const payload = payloadFor({ prompt: 'Draw a dog', history: ['Use warm colors'], size: '1536x1024' }, { API_MODE: 'chat_completions', MODEL: 'my-gpt-4o' });
  assert.equal(payload.model, 'my-gpt-4o');
  assert.match(payload.messages[0].content, /viewBox="0 0 1536 1024"/);
  assert.equal(payload.messages.at(-1).content, 'Draw a dog');
  assert.equal(payload.messages[1].content, 'Use warm colors');
  assert.equal(payload.tools, undefined);
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.match(payload.messages[0].content, /description/i);
});

test('returns an image and its description from a structured model response', () => {
  const result = illustrationFromCompletion(completion(JSON.stringify({
    kind: 'image',
    svg: drawing.replace('<title>', '<script>unsafe()</script><title>'),
    description: 'A warm brown dog drawn with simple rounded shapes.'
  })));
  assert.match(result.svg, /<circle/);
  assert.doesNotMatch(result.svg, /<script|unsafe\(\)/);
  assert.equal(result.description, 'A warm brown dog drawn with simple rounded shapes.');
});

test('accepts a description-only response without trying to parse it as SVG', () => {
  const data = completion(JSON.stringify({ kind: 'description', svg: '', description: 'The image shows a brown dog centered on the canvas.' }));
  assert.deepEqual(illustrationFromCompletion(data), {
    svg: null,
    description: 'The image shows a brown dog centered on the canvas.'
  });
  assert.throws(() => svgFromCompletion(data));
});

test('legacy SVG responses get readable descriptions from desc, title, or surrounding prose', () => {
  const withDesc = drawing.replace('<title>A dog</title>', '<title>A dog</title><desc>A brown dog &amp; a round background.</desc>');
  assert.equal(illustrationFromCompletion(completion(withDesc)).description, 'A brown dog & a round background.');
  const fenced = illustrationFromCompletion(completion('```svg\n' + drawing + '\n```'));
  assert.match(fenced.svg, /<circle/);
  assert.equal(fenced.description, 'A dog');
  const prose = illustrationFromCompletion(completion('A playful brown dog with rounded features.\n\n' + drawing));
  assert.match(prose.svg, /<circle/);
  assert.match(prose.description, /A playful brown dog with rounded features\./);
  assert.doesNotMatch(prose.description, /<svg|<circle/);
});

test('includes the actual sanitized previous drawing and description before the latest user request', () => {
  const maliciousPrior = drawing.replace('<circle ', '<script>alert(1)</script><circle onclick="alert(1)" ');
  const payload = payloadFor({
    prompt: 'Describe the image you just made',
    history: ['Draw a dog'],
    previousImage: maliciousPrior,
    previousDescription: 'A brown dog with rounded features.'
  }, { API_MODE: 'chat_completions', MODEL: 'my-gpt-4o' });
  assert.equal(payload.messages[1].content, 'Draw a dog');
  const previous = payload.messages.at(-2);
  assert.equal(previous.role, 'assistant');
  const image = JSON.parse(previous.content);
  assert.match(image.svg, /<circle/);
  assert.doesNotMatch(image.svg, /<script|onclick|alert\(1\)/);
  assert.equal(image.description, 'A brown dog with rounded features.');
  assert.equal(payload.messages.at(-1).role, 'user');
  assert.equal(payload.messages.at(-1).content, 'Describe the image you just made');
});

test('rejects invalid previous images and oversized previous descriptions before calling the provider', () => {
  const env = { API_MODE: 'chat_completions', MODEL: 'my-gpt-4o' };
  for (const previousImage of ['not an image', '<svg><circle></svg>', { svg: drawing }]) {
    assert.throws(() => payloadFor({ prompt: 'Describe this', previousImage }, env));
  }
  assert.throws(() => payloadFor({ prompt: 'Describe this', previousDescription: 'x'.repeat(4001) }, env));
});

test('preserves drawings and local gradients, and accepts fenced SVG', () => {
  const svg = svgFromCompletion({ choices: [{ finish_reason: 'stop', message: { content: '```svg\n' + drawing + '\n```' } }] });
  assert.match(svg, /<circle/); assert.match(svg, /width="1024"/);
  const gradient = sanitizeSvg('<svg viewBox="0 0 100 100"><defs><linearGradient id="paint"><stop offset="0%" stop-color="red"/></linearGradient></defs><rect width="100" height="100" fill="url(#paint)"/></svg>');
  assert.match(gradient, /fill="url\(#paint\)"/);
});

test('removes scripts, event handlers, foreign documents, CSS and external resources', () => {
  const malicious = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)"><script>alert(1)</script><style>@import url(https://bad.example)</style><foreignObject><div>unsafe</div></foreignObject><image href="https://bad.example"/><use xlink:href="https://bad.example/a.svg#x"/><animate attributeName="href" values="javascript:alert(1)"/><rect width="20" height="20" fill="url(https://bad.example)" style="background:red" onclick="alert(1)"/><text x="1" y="2">A &amp; B</text></svg>';
  const safe = sanitizeSvg(malicious);
  assert.doesNotMatch(safe, /script|onload|onclick|foreignObject|<image|<use|<style|style=|animate|https:\/\/bad/);
  assert.match(safe, /<rect/); assert.match(safe, /A &amp; B/);
});

test('rejects broken XML, DTDs, missing drawings, unsafe canvas sizes, refusals and truncation', () => {
  for (const text of [
    '<svg viewBox="0 0 100 100"><rect></svg>',
    '<!DOCTYPE svg [<!ENTITY x "bad">]><svg viewBox="0 0 10 10"><text>&x;</text></svg>',
    '<html>not SVG</html>', '<svg viewBox="0 0 100 100"/>',
    '<svg viewBox="0 0 100000 100000"><rect/></svg>',
    '<svg viewBox="0 0 100 100">' + '<g>'.repeat(50) + '<rect/>' + '</g>'.repeat(50) + '</svg>'
  ]) assert.throws(() => sanitizeSvg(text));
  assert.throws(() => svgFromCompletion({ choices: [{ finish_reason: 'length', message: { content: drawing } }] }), /cut off/);
  assert.throws(() => svgFromCompletion({ choices: [{ message: { refusal: 'declined' } }] }), /declined/);
});

test('HTTP generation returns an image with a description and accepts a follow-up description without a new image', async () => {
  let configuration;
  const providerRequests = [];
  const server = createAppServer({ getConfig: () => configuration });
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    providerRequests.push({ url: req.url, key: req.headers['api-key'], payload });
    const describing = payload.messages.at(-1).content === 'Describe that image';
    const result = describing
      ? { kind: 'description', svg: '', description: 'The image shows a round brown dog in the center.' }
      : { kind: 'image', svg: drawing.replace('<title>', '<script>unsafe()</script><title>'), description: 'A friendly brown dog drawn with rounded shapes.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion(JSON.stringify(result))));
  });
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    configuration = configFromEnv({ API_KEY: 'test-secret', API_ENDPOINT: `http://127.0.0.1:${upstream.address().port}`, DEPLOYMENT: 'gpt-4o', API_VERSION: '2024-10-21' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Draw a dog' }) });
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.images[0].format, 'svg');
    assert.equal(data.description, 'A friendly brown dog drawn with rounded shapes.');
    const source = Buffer.from(data.images[0].src.split(',')[1], 'base64').toString('utf8');
    assert.match(source, /<circle/); assert.doesNotMatch(source, /script|unsafe/);
    const followUp = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Describe that image', history: ['Draw a dog'], previousImage: source, previousDescription: data.description })
    });
    assert.equal(followUp.status, 200);
    const description = await followUp.json();
    assert.deepEqual(description.images, []);
    assert.equal(description.description, 'The image shows a round brown dog in the center.');
    assert.equal(providerRequests.length, 2);
    for (const request of providerRequests) {
      assert.equal(request.url, '/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
      assert.equal(request.key, 'test-secret');
      assert.deepEqual(request.payload.response_format, { type: 'json_object' });
    }
    assert.equal(providerRequests[0].payload.messages.at(-1).content, 'Draw a dog');
    assert.equal(JSON.parse(providerRequests[1].payload.messages.at(-2).content).svg, source);
  } finally {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => upstream.close(resolve));
  }
});
