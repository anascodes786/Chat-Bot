import { readConfig } from './config.mjs';

try {
  // Use the same normalized URL and authentication as the application.
  const config = readConfig();
  const { endpoint, header, key } = config;
  console.log(`Checking ${endpoint.host}${endpoint.pathname}; auth header: ${header}. API key is hidden.`);
  try {
    // An empty body fails validation if authentication works. It cannot generate an image.
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: config.headers,
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    console.log(`HTTP ${response.status}`);
    const message = String(data.error?.message || data.message || '').replaceAll(key, '[redacted]');
    if (message) console.log(message);
    if (response.status === 401) {
      console.log('The provider rejected the current key/endpoint pair before running the model. Confirm the key and endpoint belong to the same resource.');
      process.exitCode = 1;
    } else if (response.status === 400 || response.status === 422) {
      console.log('The endpoint processed the validation request. No image was generated.');
    } else {
      console.log('Check the provider status above; this result alone does not verify image-generation access.');
    }
  } catch (error) {
    console.error(`Connection failed: ${error.cause?.code || error.name}.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
