import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const namespace = 'http://www.w3.org/2000/svg';
const elements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'text', 'tspan', 'title', 'desc']);
const attributes = new Set(('id viewBox width height preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke color stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset fill-rule clip-rule opacity fill-opacity stroke-opacity transform clip-path gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing dx dy').split(' '));
const paintAttributes = new Set(['fill', 'stroke', 'color', 'stop-color']);
const localReference = /^url\(#[A-Za-z_][\w.-]*\)$/;
const color = /^(?:none|currentColor|transparent|[a-z]+|#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\))$/i;

export function svgPayload({ prompt, history, size, style, quality, previousImage, previousDescription }, model) {
  const [width, height] = size.split('x').map(Number);
  return {
    model,
    messages: [
      { role: 'system', content: `You are an expert SVG illustrator and image describer. Return only a JSON object with three fields: "kind" ("image" or "description"), "description" (plain text), and "svg" (SVG source code or an empty string). For a request to create or change a picture, set kind="image", write a clear 1-3 sentence description of the actual drawing, and include a complete, valid <svg xmlns="${namespace}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">...</svg> document in the svg field. For a request to describe or explain the previous image, set kind="description", explain the actual previous drawing provided in the assistant message, and set svg=""; do not redraw it. If no previous drawing is provided, explain that the user should create one first. Always include a nonempty description. Use only svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, linearGradient, radialGradient, stop, clipPath, text, tspan, title, desc. Use presentation attributes for colors, strokes and gradients. Never use style elements or style attributes, scripts, event handlers, external resources, image, use, foreignObject, animations, DOCTYPE, or entities. References must be local url(#id). Include a concise title, a descriptive desc element, a cohesive color palette, an intentional background, and recognizable subject details. Use layered vector shapes and gradients. Translate requests for photographs into expressive vector illustrations; do not claim to generate a photograph. Close every SVG tag and keep the drawing within the viewBox. Detail level: ${quality === 'high' ? 'rich, up to 120 shapes' : quality === 'low' ? 'simple, up to 30 shapes' : 'balanced, up to 70 shapes'}. Visual direction: ${style === 'auto' ? 'choose an appropriate vector illustration style' : style + ', interpreted as vector art'}. Earlier requests are context; the final request takes priority. Do not include Markdown fences.` },
      ...history.map(content => ({ role: 'user', content })),
      ...(previousImage ? [{ role: 'assistant', content: JSON.stringify({ kind: 'image', description: previousDescription || '', svg: previousImage }) }] : []),
      { role: 'user', content: prompt.trim() }
    ],
    max_completion_tokens: 8000,
    response_format: { type: 'json_object' }
  };
}

export function svgFromCompletion(data) {
  const result = illustrationFromCompletion(data);
  if (!result.svg) throw new Error('The model returned a description without a new drawing.');
  return result.svg;
}

function descriptionOf(svg) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return (document.getElementsByTagName('desc')[0]?.textContent || document.getElementsByTagName('title')[0]?.textContent || 'Here is your generated illustration.').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

export function illustrationFromCompletion(data) {
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('The SVG drawing was cut off. Try a simpler prompt or lower detail.');
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('The model declined this drawing request. Please try a different prompt.');
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The model returned no drawing or description. Please try again.');
  if (text.length > 250000) throw new Error('The response is too large. Try a simpler prompt.');
  const source = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
  let result;
  try { result = JSON.parse(source); } catch { /* Accept earlier SVG-only responses as well. */ }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (typeof result.description !== 'string' || result.description.length > 4000) throw new Error('The model returned an invalid description. Please try again.');
    if (result.kind === 'description' || (!result.kind && !result.svg)) {
      if (!result.description.trim()) throw new Error('The model returned an empty description. Please try again.');
      return { svg: null, description: result.description.trim() };
    }
    if (result.kind && result.kind !== 'image') throw new Error('The model returned an unsupported response. Please try again.');
    const svg = sanitizeSvg(result.svg);
    return { svg, description: result.description.trim() || descriptionOf(svg) };
  }
  // Extra prose must never be sent to the XML parser or inserted into the page as HTML.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('The model returned an unsupported SVG document. Try again.');
  const match = text.match(/<svg\b[\s\S]*<\/svg\s*>/i);
  if (match) {
    const svg = sanitizeSvg(match[0]);
    const prose = (text.slice(0, match.index) + '\n' + text.slice(match.index + match[0].length)).replace(/```(?:svg|xml|json)?/gi, '').trim();
    return { svg, description: prose.slice(0, 4000) || descriptionOf(svg) };
  }
  if (/<svg\b/i.test(text) || /^[{[]/.test(source)) throw new Error('The model returned an incomplete drawing response. Please try again.');
  return { svg: null, description: text.trim().slice(0, 4000) };
}

export function sanitizeSvg(text) {
  if (typeof text !== 'string' || text.length > 200000) throw new Error('The SVG drawing is too large or missing. Try a simpler prompt.');
  let source = text.trim().replace(/^```(?:svg|xml)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('The model returned an unsupported SVG document. Try again.');
  let input;
  try {
    input = new DOMParser({ onError: () => { throw new Error('Invalid SVG XML'); } }).parseFromString(source, 'image/svg+xml');
  } catch { throw new Error('The model returned an incomplete or invalid SVG drawing. Please try again.'); }
  const root = input.documentElement;
  if (!root || root.tagName !== 'svg' || (root.namespaceURI && root.namespaceURI !== namespace)) throw new Error('The model did not return a valid SVG drawing. Try again.');
  const output = new DOMParser().parseFromString(`<svg xmlns="${namespace}"/>`, 'image/svg+xml');
  let count = 0, shapes = 0;
  function copy(node, depth = 0) {
    if (++count > 3000 || depth > 40) throw new Error('The SVG drawing is too complex. Try a simpler prompt.');
    if (node.nodeType === 3 || node.nodeType === 4) return output.createTextNode(node.data);
    if (node.nodeType !== 1 || !elements.has(node.tagName) || (node.namespaceURI && node.namespaceURI !== namespace)) return null;
    const safe = output.createElementNS(namespace, node.tagName);
    if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text'].includes(node.tagName)) shapes++;
    for (let i = 0; i < node.attributes.length; i++) {
      const { name, value } = node.attributes.item(i);
      if (!attributes.has(name) || value.length > 50000) continue;
      if (name === 'id' && !/^[A-Za-z_][\w.-]*$/.test(value)) continue;
      if (paintAttributes.has(name) && !color.test(value) && !localReference.test(value)) continue;
      if (name === 'clip-path' && value !== 'none' && !localReference.test(value)) continue;
      safe.setAttribute(name, value);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) { const clean = copy(child, depth + 1); if (clean) safe.appendChild(clean); }
    return safe;
  }
  const safeRoot = copy(root);
  if (!shapes) throw new Error('The model returned no drawable SVG shapes. Try a more specific prompt.');
  const viewBox = safeRoot.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n)) || viewBox[2] <= 0 || viewBox[3] <= 0 || viewBox[2] > 4096 || viewBox[3] > 4096) throw new Error('The SVG drawing has an invalid canvas size. Please try again.');
  safeRoot.setAttribute('width', String(viewBox[2])); safeRoot.setAttribute('height', String(viewBox[3]));
  output.replaceChild(safeRoot, output.documentElement);
  return new XMLSerializer().serializeToString(output);
}
