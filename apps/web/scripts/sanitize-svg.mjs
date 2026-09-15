// Allow-list SVG sanitiser for vendored brand logos (apps/web/public/logos). Dependency-free and linear: one pass over
// the input with index arithmetic, no backtracking regular expressions. The output is re-serialised from the parsed
// allow-listed elements and attributes, so nothing the input smuggles in (scripts, event handlers, foreignObject,
// styles, external references, data: URIs) survives.

const ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path', 'title', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

const SHAPE_ATTRIBUTES = ['fill', 'fill-rule', 'clip-rule', 'fill-opacity', 'opacity', 'transform', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
const ALLOWED_ATTRIBUTES = {
  svg: new Set(['viewBox', 'xmlns', 'role', 'fill']),
  g: new Set(SHAPE_ATTRIBUTES),
  path: new Set(['d', ...SHAPE_ATTRIBUTES]),
  title: new Set(),
  circle: new Set(['cx', 'cy', 'r', ...SHAPE_ATTRIBUTES]),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', ...SHAPE_ATTRIBUTES]),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', ...SHAPE_ATTRIBUTES]),
  line: new Set(['x1', 'y1', 'x2', 'y2', ...SHAPE_ATTRIBUTES]),
  polyline: new Set(['points', ...SHAPE_ATTRIBUTES]),
  polygon: new Set(['points', ...SHAPE_ATTRIBUTES]),
};

const FORBIDDEN_VALUE_MARKERS = ['url(', 'data:', 'javascript:', 'http:', 'https:', '&', '<', '>', '"', '`'];
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isNameChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_' || ch === ':';
}

function isSpace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

function safeValue(name, value) {
  if (name === 'xmlns') return value === SVG_NAMESPACE;
  const lower = value.toLowerCase();
  return !FORBIDDEN_VALUE_MARKERS.some((marker) => lower.includes(marker));
}

/** Parses the attributes between `start` and `end` (exclusive) of a start tag. Unquoted values are rejected. */
function parseAttributes(source, start, end) {
  const attributes = [];
  let i = start;
  while (i < end) {
    while (i < end && isSpace(source[i])) i++;
    const nameStart = i;
    while (i < end && isNameChar(source[i])) i++;
    const name = source.slice(nameStart, i);
    if (!name) {
      i++;
      continue;
    }
    while (i < end && isSpace(source[i])) i++;
    if (source[i] !== '=') {
      attributes.push({ name, value: null });
      continue;
    }
    i++;
    while (i < end && isSpace(source[i])) i++;
    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      while (i < end && !isSpace(source[i])) i++;
      continue;
    }
    const valueStart = i + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0 || valueEnd > end) break;
    attributes.push({ name, value: source.slice(valueStart, valueEnd) });
    i = valueEnd + 1;
  }
  return attributes;
}

/** Finds the `>` closing a tag, skipping quoted attribute values. */
function findTagEnd(source, from) {
  let quote = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function escapeText(text) {
  let out = '';
  for (const ch of text) {
    if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '&') out += '&amp;';
    else out += ch;
  }
  return out;
}

/**
 * Returns a sanitised SVG document. `fill` (a #rrggbb colour) is set on the root element, which single-colour icons
 * inherit. Throws when the input has no `<svg>` root with a viewBox.
 */
export function sanitizeSvg(input, { fill } = {}) {
  if (typeof input !== 'string') throw new TypeError('SVG input must be a string');
  if (fill !== undefined && !HEX_COLOR.test(fill)) throw new Error(`invalid fill colour: ${fill}`);

  const out = [];
  const stack = []; // open allowed elements
  let skipDepth = 0; // > 0 while inside a disallowed element
  let rootSeen = false;
  let rootHasViewBox = false;
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    const textEnd = lt < 0 ? input.length : lt;
    if (textEnd > i && skipDepth === 0 && stack[stack.length - 1] === 'title') {
      out.push(escapeText(input.slice(i, textEnd).trim()));
    }
    if (lt < 0) break;

    // Comments, CDATA, doctype and processing instructions are dropped entirely.
    if (input.startsWith('<!--', lt)) {
      const close = input.indexOf('-->', lt + 4);
      i = close < 0 ? input.length : close + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const close = input.indexOf(']]>', lt + 9);
      i = close < 0 ? input.length : close + 3;
      continue;
    }
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const close = findTagEnd(input, lt + 2);
      i = close < 0 ? input.length : close + 1;
      continue;
    }

    const end = findTagEnd(input, lt + 1);
    if (end < 0) break;
    const closing = input[lt + 1] === '/';
    let nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < end && isNameChar(input[nameEnd])) nameEnd++;
    const name = input.slice(nameStart, nameEnd);
    const selfClosing = !closing && input[end - 1] === '/';
    i = end + 1;
    if (!name) continue;

    if (closing) {
      if (skipDepth > 0) {
        skipDepth--;
        continue;
      }
      if (stack[stack.length - 1] === name) {
        stack.pop();
        out.push(`</${name}>`);
      }
      continue;
    }

    if (skipDepth > 0 || !ALLOWED_ELEMENTS.has(name) || (name === 'svg' && rootSeen) || (name !== 'svg' && !rootSeen)) {
      if (!selfClosing) skipDepth++;
      continue;
    }

    const allowed = ALLOWED_ATTRIBUTES[name];
    const attributes = parseAttributes(input, nameEnd, selfClosing ? end - 1 : end).filter(
      (attribute) => attribute.value !== null && allowed.has(attribute.name) && safeValue(attribute.name, attribute.value),
    );
    if (name === 'svg') {
      rootSeen = true;
      rootHasViewBox = attributes.some((attribute) => attribute.name === 'viewBox');
      const kept = attributes.filter((attribute) => attribute.name !== 'xmlns' && !(fill && attribute.name === 'fill'));
      kept.unshift({ name: 'xmlns', value: SVG_NAMESPACE });
      if (fill) kept.push({ name: 'fill', value: fill });
      attributes.length = 0;
      attributes.push(...kept);
    }
    const serialised = attributes.map((attribute) => ` ${attribute.name}="${attribute.value}"`).join('');
    if (selfClosing) {
      out.push(`<${name}${serialised}/>`);
    } else {
      out.push(`<${name}${serialised}>`);
      stack.push(name);
    }
  }

  if (!rootSeen || !rootHasViewBox) throw new Error('SVG root with a viewBox is required');
  while (stack.length > 0) out.push(`</${stack.pop()}>`);
  return `${out.join('')}\n`;
}
