const $ = id => document.getElementById(id);
let sessions = [], active = null, busy = false;
try {
  sessions = JSON.parse(localStorage.getItem('imagine-history') || '[]');
  if (!Array.isArray(sessions)) sessions = [];
  sessions = sessions.filter(s => s && typeof s.id === 'string' && Array.isArray(s.messages));
} catch {}

function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

function save() {
  // Persist prompts only: large generated images remain in memory for this visit.
  try {
    localStorage.setItem('imagine-history', JSON.stringify(sessions.slice(0, 30).map(session => ({
      ...session,
      messages: session.messages.filter(message => message.role === 'user').slice(-12)
    }))));
  } catch {
    $('status').textContent = 'Browser storage is full. This conversation will remain available for this visit.';
  }
}

function current() { return sessions.find(session => session.id === active); }

function updatePromptCount() {
  if ($('prompt-count')) $('prompt-count').textContent = `${$('prompt').value.length} / 8000`;
}

function setPrompt(value) {
  $('prompt').value = value;
  updatePromptCount();
  $('prompt').focus();
}

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('sidebar-toggle')?.setAttribute('aria-expanded', String(open));
}

function messageBox(role, text, extraClass = '') {
  const box = node('article', '', `message ${role}${extraClass ? ` ${extraClass}` : ''}`);
  const heading = node('div', '', 'message-heading');
  heading.append(node('span', role === 'user' ? 'You' : 'Imagine', 'speaker-label'));
  heading.append(node('span', role === 'user' ? 'Your prompt' : 'Creative assistant', 'message-kind'));
  box.append(heading);
  if (text) box.append(node('p', text, 'message-text'));
  return box;
}

function restoreGenerateButton() {
  const arrow = node('span', '\u2197');
  arrow.setAttribute('aria-hidden', 'true');
  $('generate').replaceChildren(document.createTextNode('Generate image '), arrow);
}

function previousImageContext(session) {
  const message = session.messages.findLast(m => m.role === 'bot' && m.images?.length);
  const source = message?.images.at(-1)?.src;
  const prefix = 'data:image/svg+xml;base64,';
  if (typeof source !== 'string' || !source.startsWith(prefix) || source.length - prefix.length > 200000) return {};
  try {
    const bytes = Uint8Array.from(atob(source.slice(prefix.length)), c => c.charCodeAt(0));
    const previousImage = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (previousImage.length > 150000) return {};
    return { previousImage, previousDescription: (message.text || '').slice(0, 4000) };
  } catch { return {}; }
}

async function downloadPng(img, button, box) {
  button.disabled = true;
  try {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    if (!canvas.width || !canvas.height || canvas.width > 4096 || canvas.height > 4096) throw new Error('Invalid canvas size');
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG export failed');
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = `imagine-${Date.now()}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    box.append(node('small', 'PNG export failed. You can still download the SVG drawing.', 'export-error'));
  } finally { button.disabled = false; }
}

function render() {
  $('history').replaceChildren();
  if (!sessions.length) $('history').append(node('p', 'Your creations will appear here.', 'history-empty'));
  for (const session of sessions) {
    const title = session.messages.find(message => message.role === 'user')?.text || 'Untitled creation';
    const button = node('button', '', session.id === active ? 'active' : '');
    button.type = 'button';
    button.title = title;
    if (session.id === active) button.setAttribute('aria-current', 'page');
    button.append(node('span', title, 'history-title'));
    const arrow = node('span', '\u2197', 'history-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(arrow);
    button.onclick = () => {
      if (busy) return;
      active = session.id;
      setSidebar(false);
      render();
    };
    $('history').append(button);
  }

  const messages = current()?.messages || [];
  $('welcome').hidden = messages.length > 0;
  $('messages').replaceChildren();
  for (const message of messages) {
    const box = messageBox(message.role === 'user' ? 'user' : 'bot', message.text);
    for (const [index, image] of (message.images || []).entries()) {
      if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,|^https:\/\//i.test(image.src)) continue;
      const isSvg = image.src.startsWith('data:image/svg+xml;base64,');
      const img = node('img');
      img.src = image.src;
      img.alt = image.description || message.text || message.prompt || 'Generated image';
      img.loading = 'lazy';
      img.decoding = 'async';
      const frame = node('div', '', 'image-frame');
      frame.append(img);
      box.append(frame);
      const actions = node('div', '', 'actions');
      const link = node('a', isSvg ? '\u2193 Download SVG' : image.src.startsWith('data:') ? '\u2193 Download image' : 'Open image');
      link.href = image.src;
      link.download = `imagine-${Date.now()}-${index + 1}.${isSvg ? 'svg' : 'png'}`;
      if (!image.src.startsWith('data:')) link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
      if (isSvg) {
        const png = node('button', '\u2193 Download PNG');
        png.type = 'button';
        png.onclick = () => downloadPng(img, png, box);
        actions.append(png);
      }
      box.append(actions);
    }
    if (message.role === 'bot' && message.prompt) {
      const button = node('button', 'Use prompt again');
      button.type = 'button';
      button.onclick = () => setPrompt(message.prompt);
      const actions = node('div', '', 'actions');
      actions.append(button);
      box.append(actions);
    }
    $('messages').append(box);
  }
}

$('new-chat').onclick = () => {
  if (busy) return;
  active = null;
  setSidebar(false);
  render();
  setPrompt('');
};
$('clear').onclick = () => {
  if (!busy && confirm('Delete all saved conversations from this browser?')) {
    sessions = [];
    active = null;
    save();
    render();
    setSidebar(false);
  }
};
$('setup').onclick = () => $('guide').showModal();
$('close-guide').onclick = () => $('guide').close();
$('sidebar-toggle')?.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
$('sidebar-close')?.addEventListener('click', () => setSidebar(false));
$('sidebar-overlay')?.addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setSidebar(false); });
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => setPrompt(button.dataset.prompt);
});
const surprisePrompts = [
  'A serene Japanese tea house beside a koi pond, soft morning mist, elegant editorial illustration in sage and warm ivory.',
  'A little astronaut discovering a garden on the moon, playful shapes, warm terracotta and midnight blue, charming illustration.',
  'An elegant perfume bottle on sculpted stone, golden afternoon light, botanical details, refined minimal composition.',
  'A friendly golden retriever sitting in a sunlit park, expressive face, rich natural colors, polished storybook illustration.',
  'A coastal village above a turquoise sea, winding paths and citrus trees, warm Mediterranean illustration.'
];
$('surprise')?.addEventListener('click', () => setPrompt(surprisePrompts[Math.floor(Math.random() * surprisePrompts.length)]));
$('prompt').addEventListener('input', updatePromptCount);
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) $('composer').requestSubmit();
  }
});

$('composer').onsubmit = async event => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || busy) return;
  busy = true;
  $('generate').disabled = true;
  $('generate').textContent = 'Creating\u2026';
  $('composer').setAttribute('aria-busy', 'true');
  setSidebar(false);
  if (!current()) {
    active = crypto.randomUUID();
    sessions.unshift({ id: active, messages: [] });
  }
  const session = current();
  const history = session.messages.filter(message => message.role === 'user').slice(-12).map(message => message.text);
  const imageContext = previousImageContext(session);
  session.messages.push({ role: 'user', text: prompt });
  $('prompt').value = '';
  updatePromptCount();
  save();
  render();
  const loading = messageBox('bot', '', 'loading');
  loading.setAttribute('role', 'status');
  const loadingContent = node('div', '', 'loading-content');
  const spinner = node('span', '', 'loading-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const loadingCopy = node('div', '', 'loading-copy');
  loadingCopy.append(node('strong', 'A little imagination in progress'));
  loadingCopy.append(node('p', 'Creating your image and its description. This may take a moment.'));
  loadingContent.append(spinner, loadingCopy);
  loading.append(loadingContent);
  $('messages').append(loading);
  loading.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, history, ...imageContext, style: $('style').value, size: $('size').value, quality: $('quality').value }),
      signal: AbortSignal.timeout(190000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error((data.error || 'Generation failed. Please try again.') + (data.detail ? '\nProvider: ' + data.detail : ''));
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    session.messages.push({ role: 'bot', text: description || 'Here\u2019s your imagination, brought to life.', prompt, images: data.images });
    save();
    render();
    $('messages').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    loading.remove();
    const box = messageBox('bot', error.name === 'TimeoutError' ? 'The request timed out. Please try again.' : error.message, 'error');
    const retry = node('button', 'Restore prompt');
    retry.type = 'button';
    retry.onclick = () => setPrompt(prompt);
    const actions = node('div', '', 'actions');
    actions.append(retry);
    box.append(actions);
    $('messages').append(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally {
    busy = false;
    $('generate').disabled = false;
    $('composer').setAttribute('aria-busy', 'false');
    restoreGenerateButton();
  }
};

render();
updatePromptCount();
fetch('/api/status').then(response => response.json()).then(status => {
  $('status').textContent = status.configured ? 'Ready to create' : 'Setup needed';
  $('status').dataset.state = status.configured ? 'ready' : 'setup';
  $('status').title = status.configured ? 'Your settings are loaded. Connection is checked when you generate.' : status.configurationError || 'Add your API key and endpoint in the setup guide.';
  if ($('model-label')) $('model-label').textContent = status.model || 'GPT-4o';
  $('output-badge').textContent = 'Creative workspace';
  $('quality-label').firstChild.textContent = status.outputFormat === 'svg' ? 'Detail' : 'Quality';
}).catch(() => {
  $('status').textContent = 'Server unavailable';
  $('status').dataset.state = 'offline';
  $('status').title = 'Start the app with npm start, then refresh this page.';
});
