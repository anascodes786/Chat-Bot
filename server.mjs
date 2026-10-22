import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { svgPayload, illustrationFromCompletion, sanitizeSvg } from './svg.mjs';
import { readConfig } from './config.mjs';

export function payloadFor(body, env = process.env) {
  const { prompt, size = '1024x1024', quality = 'auto', style = 'auto', history = [], previousImage, previousDescription = '' } = body;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('Enter a prompt between 1 and 8,000 characters.');
  if (!['1024x1024', '1536x1024', '1024x1536'].includes(size)) throw new Error('Invalid image size.');
  if (!['auto', 'low', 'medium', 'high'].includes(quality)) throw new Error('Invalid image quality.');
  if (!['auto', 'photographic', 'illustration', '3D render', 'cinematic'].includes(style)) throw new Error('Invalid style.');
  if (!Array.isArray(history) || history.length > 12 || history.some(p => typeof p !== 'string' || p.length > 8000)) throw new Error('Invalid conversation history.');
  if (previousImage !== undefined && (typeof previousImage !== 'string' || previousImage.length > 200000)) throw new Error('Invalid previous image.');
  if (typeof previousDescription !== 'string' || previousDescription.length > 4000) throw new Error('Invalid previous description.');
  if (env.API_MODE === 'chat_completions') return svgPayload({ prompt, history, size, style, quality, previousImage: previousImage ? sanitizeSvg(previousImage) : undefined, previousDescription }, env.MODEL || 'gpt-4o');
  if (env.API_MODE && !['responses', 'images'].includes(env.API_MODE)) throw new Error('Unsupported API_MODE. Use chat_completions, responses, or images.');
  const input = `${history.length ? 'Earlier image requests for context (text only):\n' + history.join('\n') + '\n\n' : ''}Create an image for this request: ${prompt.trim()}${style === 'auto' ? '' : '\nVisual style: ' + style}`;
  if (env.API_MODE === 'images') return { model: env.MODEL || 'gpt-image-1', prompt: input, n: 1, size, quality };
  return { model: env.MODEL || 'gpt-4o', input, tools: [{ type: 'image_generation', size, quality }], tool_choice: { type: 'image_generation' } };
}

export function extractImages(data) {
  const result = [];
  for (const item of data.output || []) if (item.type === 'image_generation_call' && item.result) result.push({ src: `data:image/png;base64,${item.result}`, revisedPrompt: item.revised_prompt || '' });
  for (const item of data.data || []) {
    if (item.b64_json) result.push({ src: `data:image/png;base64,${item.b64_json}`, revisedPrompt: item.revised_prompt || '' });
    else if (item.url && /^https:\/\//i.test(item.url)) result.push({ src: item.url, revisedPrompt: item.revised_prompt || '' });
  }
  return result;
}

const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
export function createAppServer({ getConfig = readConfig, providerFetch = fetch } = {}) {
return http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; }
  catch { return json(res, 400, { error: 'Invalid request URL.' }); }
  if (req.method === 'GET' && path === '/api/status') {
    try { const config = getConfig(); return json(res, 200, { configured: true, model: config.model, mode: config.mode, outputFormat: config.outputFormat }); }
    catch (error) { return json(res, 200, { configured: false, configurationError: error.message }); }
  }
  if (req.method === 'POST' && path === '/api/generate') {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Request origin is not allowed.' });
    let config;
    try { config = getConfig(); } catch (error) { return json(res, 503, { error: error.message, code: 'CONFIGURATION_ERROR' }); }
    let payload;
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 500000) { json(res, 413, { error: 'Request is too large.' }); return; } }
      payload = payloadFor(JSON.parse(raw), { API_MODE: config.mode, MODEL: config.model });
    } catch (e) { return json(res, 400, { error: e instanceof SyntaxError ? 'Invalid JSON request.' : e.message }); }
    try {
      const response = await providerFetch(config.endpoint, { method: 'POST', headers: config.headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(180000), redirect: 'error' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages = { 401: config.azure ? 'Azure rejected the API key or endpoint. Confirm they belong to the same Azure resource. Update .env and try again; no restart is needed.' : 'API authentication failed. Check your key and authentication settings.', 403: 'Your provider denied access. Check deployment permissions.', 404: 'Endpoint or model not found. Check the full URL and model/deployment name.', 429: 'Provider rate limit or quota reached. Please try later or check billing.' };
        const providerMessage = String(data.error?.message || '').replaceAll(config.key, '[redacted]').slice(0, 500);
        console.error('Image provider rejected request:', response.status);
        return json(res, response.status >= 500 ? 502 : response.status, { error: messages[response.status] || 'The provider rejected the request. Check that API_MODE, model, and image settings match your endpoint.', providerStatus: response.status, ...(providerMessage ? { detail: providerMessage } : {}) });
      }
      let images, description = '';
      if (config.outputFormat === 'svg') {
        try {
          const result = illustrationFromCompletion(data);
          description = result.description;
          images = result.svg ? [{ src: `data:image/svg+xml;base64,${Buffer.from(result.svg).toString('base64')}`, format: 'svg', description }] : [];
        } catch (error) { return json(res, 502, { error: error.message }); }
      } else images = extractImages(data);
      if (!images.length && !description) return json(res, 502, { error: 'The provider returned no image or description. Verify that this model and endpoint support this request.' });
      return json(res, 200, { images, description });
    } catch (e) {
      const code = e.cause?.code || e.code;
      // Log only the error category, never credentials or request headers.
      console.error('Image provider connection failed:', code || e.name);
      const reasons = {
        EACCES: 'The server environment blocked the outgoing connection. Run npm start from your own terminal with network access.',
        EPERM: 'The server environment blocked the outgoing connection. Run npm start from your own terminal with network access.',
        ENOTFOUND: 'The endpoint hostname could not be found. Check API_ENDPOINT in .env.',
        ECONNREFUSED: 'The provider refused the connection. Check the endpoint and network settings.',
        ECONNRESET: 'The connection to the provider was interrupted. Check your network or proxy.',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The provider TLS certificate could not be verified. Check your network certificate configuration.',
        UND_ERR_CONNECT_TIMEOUT: 'Connecting to the provider timed out. Check network access to your endpoint.'
      };
      return json(res, 502, { error: e.name === 'TimeoutError' ? 'Generation timed out after 3 minutes. Please try again.' : reasons[code] || 'Could not reach the image provider. Check your endpoint and network connection.', ...(code ? { code } : {}) });
    }
  }
  if (req.method === 'GET' && assets[path]) {
    const [file, type] = assets[path];
    try { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(new URL(`./public/${file}`, import.meta.url))); } catch { res.end('Asset unavailable'); } return;
  }
  json(res, 404, { error: 'Not found' });
});
}
export const server = createAppServer();
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`))) {
  const port = Number(process.env.PORT) || 3000;
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the existing server with Ctrl+C in its terminal, or change PORT in .env, then run npm start again.`
      : `Server could not start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Imagine Studio: http://localhost:${port}`));
}
