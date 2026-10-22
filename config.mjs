import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function configFromEnv(env) {
  const key = env.API_KEY?.trim();
  if (!key || !env.API_ENDPOINT?.trim()) throw new Error('Add API_KEY and API_ENDPOINT to .env.');
  const deployment = env.DEPLOYMENT?.trim();
  const apiVersion = env.API_VERSION?.trim();
  if (!deployment || !apiVersion) throw new Error('Add DEPLOYMENT and API_VERSION to .env.');
  let endpoint;
  try { endpoint = new URL(env.API_ENDPOINT.trim()); } catch { throw new Error('API_ENDPOINT must be a valid URL.'); }
  if (endpoint.username || endpoint.password) throw new Error('Keep credentials in API_KEY, not in API_ENDPOINT.');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('API_ENDPOINT must use HTTPS.');
  const azure = /\.(?:services\.ai\.azure\.com|openai\.azure\.com|cognitiveservices\.azure\.com)$/.test(endpoint.hostname);
  // Accept the resource endpoint, its /openai/v1 base, or a copied request URL.
  const base = endpoint.pathname.replace(/\/openai(?:\/.*)?\/?$/, '').replace(/\/+$/, '');
  endpoint.pathname = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
  endpoint.searchParams.set('api-version', apiVersion);
  endpoint.hash = '';
  const header = 'api-key';
  const headers = { 'Content-Type': 'application/json', 'api-key': key };
  try { new Headers(headers); } catch { throw new Error('The API key or authentication header contains invalid characters.'); }
  return { key, endpoint, headers, header, azure, mode: 'chat_completions', model: deployment, outputFormat: 'svg' };
}

export function readConfig({ env = process.env, file = new URL('./.env', import.meta.url) } = {}) {
  // The user's local configuration wins over environment variables inherited at startup.
  // Read once per request so a corrected key or endpoint takes effect immediately.
  let local = {};
  try { local = parseEnv(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .env. Check its file permissions and syntax.'); }
  return configFromEnv({ ...env, ...local });
}
