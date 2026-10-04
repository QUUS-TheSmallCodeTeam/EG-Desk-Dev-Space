import { usableArtifact } from './EGDeskChatState.sys.mjs';

// Deliberately small renderer: retain the existing fences, emphasis, code and
// web links, while treating code/link destinations as opaque before emphasis.
const control = /[\u0000-\u001f\u007f]/;
const word = value => typeof value === 'string' && /[\p{L}\p{N}_]/u.test(value);
const space = value => value === undefined || typeof value === 'string' && /\s/.test(value);
const unescape = text => text.replace(/\\([\\`*_[\]()<> ])/g, '$1');
function textToken(tokens, value) {
  if (!value) return;
  const last = tokens.at(-1);
  if (last?.type === 'text') last.value += value;
  else tokens.push({ type: 'text', value });
}

function readLink(text, start) {
  let depth = 1;
  let close = start + 1;
  for (; close < text.length; close++) {
    if (text[close] === '\\') { close++; continue; }
    if (text[close] === '[') depth++;
    if (text[close] === ']' && --depth === 0) break;
  }
  if (text[close] !== ']' || text[close + 1] !== '(') return null;
  let end = close + 2;
  depth = 1;
  let angle = false;
  for (; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '<') angle = true;
    if (text[end] === '>') angle = false;
    if (!angle && text[end] === '(') depth++;
    if (!angle && text[end] === ')' && --depth === 0) break;
  }
  if (text[end] !== ')') return null;
  let destination = text.slice(close + 2, end).trim();
  if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
  return { token: { type: 'link', label: text.slice(start + 1, close), destination: unescape(destination) }, end: end + 1 };
}

function trimBareUrl(raw) {
  let url = raw.replace(/[.,;!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    let extra = [...url].filter(c => c === close).length - [...url].filter(c => c === open).length;
    while (extra > 0 && url.endsWith(close)) { url = url.slice(0, -1); extra--; }
  }
  return url;
}

function protectedInline(text, allowLinks) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\`*_[\]()<>]/.test(text[i + 1] || '')) {
      tokens.push({ type: 'literal', value: text[i + 1] }); i += 2; continue;
    }
    if (text[i] === '`') {
      let count = 1;
      while (text[i + count] === '`') count++;
      const delimiter = '`'.repeat(count);
      let end = text.indexOf(delimiter, i + count);
      while (end >= 0 && (text[end - 1] === '`' || text[end + count] === '`')) end = text.indexOf(delimiter, end + count);
      if (end >= 0) {
        let value = text.slice(i + count, end).replace(/\r?\n/g, ' ');
        if (/^ .* $/.test(value) && /\S/.test(value)) value = value.slice(1, -1);
        tokens.push({ type: 'code', value }); i = end + count; continue;
      }
      textToken(tokens, delimiter); i += count; continue;
    }
    if (allowLinks && text[i] === '[') {
      const link = readLink(text, i);
      if (link) { tokens.push(link.token); i = link.end; continue; }
    }
    const autoLink = allowLinks && text[i] === '<' && text.slice(i).match(/^<(https?:\/\/[^<>\s]+)>/i);
    if (autoLink) {
      tokens.push({ type: 'link', label: autoLink[1], destination: autoLink[1] }); i += autoLink[0].length; continue;
    }
    const html = text[i] === '<' && text.slice(i).match(/^<\/?[A-Za-z][^>]*>/);
    if (html) { tokens.push({ type: 'literal', value: html[0] }); i += html[0].length; continue; }
    const bare = allowLinks && /h/i.test(text[i]) && text.slice(i).match(/^https?:\/\/[^\s<>]+/i);
    if (bare) {
      const url = trimBareUrl(bare[0]);
      tokens.push({ type: 'link', label: url, destination: url }); i += url.length; continue;
    }
    textToken(tokens, text[i++]);
  }
  return tokens;
}

export function inlineMarkdown(text, allowLinks = true) {
  const units = protectedInline(String(text || ''), allowLinks).flatMap(token => token.type === 'text' ? [...token.value] : [token]);
  const closers = { '*': [], '**': [], '_': [], '__': [] };
  const runLength = i => units[i + 1] === units[i] ? 2 : 1;
  for (let i = 0; i < units.length; i++) {
    const marker = units[i];
    if (!['*', '_'].includes(marker) || units[i - 1] === marker) continue;
    const length = runLength(i);
    if (!space(units[i - 1]) && (marker !== '_' || !word(units[i + length]))) closers[marker.repeat(length)].push(i);
  }
  const closingAfter = (list, minimum, end) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid] < minimum) lo = mid + 1; else hi = mid; }
    return list[lo] < end ? list[lo] : -1;
  };
  const parse = (start, end, depth = 0) => {
    const tokens = [];
    for (let i = start; i < end;) {
      const unit = units[i];
      if (typeof unit !== 'string') { tokens.push(unit); i++; continue; }
      const length = runLength(i);
      if (depth < 8 && ['*', '_'].includes(unit) && units[i - 1] !== unit
          && !space(units[i + length]) && (unit !== '_' || !word(units[i - 1]))) {
        const close = closingAfter(closers[unit.repeat(length)], i + length + 1, end);
        if (close >= 0 && close + length <= end) {
          tokens.push({ type: length === 2 ? 'strong' : 'em', children: parse(i + length, close, depth + 1) });
          i = close + length; continue;
        }
      }
      textToken(tokens, unit); i++;
    }
    return tokens;
  };
  return parse(0, units.length);
}

function localPaths(destination) {
  if (control.test(destination)) return [];
  let path = destination;
  if (/^file:/i.test(path)) {
    const match = path.match(/^file:\/\/([^/]*)(\/[^?#]*)/i);
    if (!match || match[1] && match[1].toLowerCase() !== 'localhost') return [];
    path = match[2];
  }
  if (!/^\/(?!\/)/.test(path)) return [];
  const paths = [path];
  try { const decoded = decodeURIComponent(path); if (!control.test(decoded) && decoded !== path) paths.push(decoded); } catch {}
  return paths;
}

export function verifiedFileLink(destination, context = {}) {
  if (!context.answerId || !context.conversationId || !context.runId) return null;
  for (const path of localPaths(destination)) {
    const artifact = (context.artifacts || []).find(item => usableArtifact(item)
      && item.answerId === context.answerId && item.conversationId === context.conversationId
      && item.runId === context.runId && item.target.path === path);
    if (artifact) return artifact;
  }
  return null;
}

const webDestination = value => !control.test(value) && /^https?:\/\/[^\s/?#<>"']+[^\s<>"']*$/i.test(value);
function plainInline(tokens) {
  return tokens.map(token => token.children ? plainInline(token.children) : token.type === 'link' ? plainInline(inlineMarkdown(token.label, false)) : token.value || '').join('');
}

export function appendMarkdown(container, text, context = {}) {
  text = String(text || '');
  const doc = container.ownerDocument;
  const element = (tag, className) => { const node = doc.createElement(tag); if (className) node.setAttribute('class', className); return node; };
  const literal = (parent, value, breaks = true) => {
    const lines = breaks ? value.split('\n') : [value];
    lines.forEach((line, index) => { if (index) parent.appendChild(element('br')); if (line) parent.appendChild(doc.createTextNode(line)); });
  };
  const render = (parent, tokens) => {
    for (const token of tokens) {
      if (token.type === 'text' || token.type === 'literal') { literal(parent, token.value); continue; }
      if (token.type === 'code') { const code = element('code', 'egd-codex-inline-code'); literal(code, token.value, false); parent.appendChild(code); continue; }
      if (token.children) { const node = element(token.type); render(node, token.children); parent.appendChild(node); continue; }
      const artifact = verifiedFileLink(token.destination, context);
      const web = webDestination(token.destination);
      const clickable = artifact && typeof context.openArtifact === 'function' || web && typeof context.openWeb === 'function';
      const node = element(clickable ? 'a' : 'span', clickable ? 'egd-codex-inline-link' : 'egd-codex-inline-unverified');
      node.setAttribute('title', artifact ? artifact.target.path : web ? token.destination : '연결을 확인하지 않은 참조');
      if (clickable) {
        node.setAttribute('role', 'link'); node.setAttribute('tabindex', '0');
        if (artifact) {
          node.setAttribute('data-testid', 'chat-inline-artifact');
          node.setAttribute('data-artifact-id', artifact.id);
          node.setAttribute('data-answer-id', artifact.answerId);
          node.setAttribute('aria-label', `참조된 파일 열기: ${plainInline(inlineMarkdown(token.label, false))}`);
        } else node.setAttribute('href', token.destination);
        const activate = event => {
          event.preventDefault(); event.stopPropagation();
          if (artifact) { const current = verifiedFileLink(token.destination, context); if (current) context.openArtifact(current); }
          else context.openWeb(token.destination);
        };
        node.addEventListener('click', activate);
        // File references have no href: every activation must use the verified object.
        if (artifact) node.addEventListener('keydown', event => { if (event.key === 'Enter') activate(event); });
      } else node.setAttribute('data-verification', 'unverified');
      render(node, inlineMarkdown(token.label, false));
      parent.appendChild(node);
    }
  };
  const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    render(container, inlineMarkdown(text.slice(last, match.index)));
    const pre = element('pre', 'egd-codex-code-block');
    const code = element('code', match[1] ? `language-${match[1]}` : '');
    literal(code, match[2].replace(/\n$/, ''), false); pre.appendChild(code); container.appendChild(pre);
    last = match.index + match[0].length;
  }
  render(container, inlineMarkdown(text.slice(last)));
}

export function plainMarkdownText(text) {
  return plainInline(inlineMarkdown(String(text || '').replace(/```[\s\S]*?```/g, '[code]'))).replace(/\n/g, ' ').trim();
}
