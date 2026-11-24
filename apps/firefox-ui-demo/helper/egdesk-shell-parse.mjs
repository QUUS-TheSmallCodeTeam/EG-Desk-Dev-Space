// A small, conservative reader of one shell command line, for the command gate (egdesk-terminal-command-gate.mjs).
// It does not run or expand anything. It recovers the simple commands a line would run, in order, with:
//   - quoting ('…', "…", \x), comments, line continuations;
//   - separators ; && || & newline, pipelines | |&, subshells ( … ) (a cd inside does not leak out), { … } groups;
//   - redirections (> >> < 2> &> >& <> and the fd forms), here-strings <<< and here-documents <<EOF … EOF (their text is kept
//     as the command's standard input);
//   - command substitution $( … ) and `…`, process substitution <( … ) >( … ): their inner commands are read too (they run);
//     a word that contains one, or a $variable, is "dynamic" (its value is not known before it runs).
// What it cannot know it says so (dynamic), so a caller can treat it as unknown rather than as harmless.
export const SHELL_PARSE_LIMITS = Object.freeze({ chars: 8000, depth: 4, commands: 64 })

function readBalanced(text, start) {
  let depth = 1, quote = null
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (quote) { if (c === '\\' && quote === '"') { j++; continue } if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') { j++; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return { inner: text.slice(start, j), end: j + 1 }
  }
  return { inner: text.slice(start), end: text.length }
}

/** Tokens: { t: 'w', v, dyn, subs: [inner text], proc? } | { t: 'op', v } | { t: 'doc', v } (here-document text). */
export function lexShell(input) {
  const text = String(input ?? '').slice(0, SHELL_PARSE_LIMITS.chars)
  const tokens = []
  let word = null, i = 0, parens = 0
  const docs = [] // pending here-document delimiters
  const start = () => { if (!word) word = { t: 'w', v: '', dyn: false, subs: [] } }
  const end = () => { if (word) { tokens.push(word); word = null } }
  const substitute = (inner, mark) => { start(); word.subs.push(inner); word.dyn = true; word.v += mark }
  while (i < text.length) {
    const c = text[i], two = text.slice(i, i + 2), three = text.slice(i, i + 3)
    if (c === '\\') { if (text[i + 1] === '\n') { i += 2; continue } start(); word.v += text[i + 1] ?? ''; i += 2; continue }
    if (c === "'") { start(); const j = text.indexOf("'", i + 1), stop = j < 0 ? text.length : j; word.v += text.slice(i + 1, stop); i = stop + 1; continue }
    if (c === '"') {
      start(); i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) { word.v += text[i + 1]; i += 2; continue }
        if (text[i] === '$' && text[i + 1] === '(') { const r = readBalanced(text, i + 2); substitute(r.inner, '$(…)'); i = r.end; continue }
        if (text[i] === '`') { const j = text.indexOf('`', i + 1), stop = j < 0 ? text.length : j; substitute(text.slice(i + 1, stop), '`…`'); i = stop + 1; continue }
        if (text[i] === '$' && /[A-Za-z_{@*#?!$0-9]/.test(text[i + 1] ?? '')) word.dyn = true
        word.v += text[i]; i++
      }
      i++; continue
    }
    if (c === '$' && text[i + 1] === '(') { const r = readBalanced(text, i + 2); substitute(r.inner, '$(…)'); i = r.end; continue }
    if (c === '`') { const j = text.indexOf('`', i + 1), stop = j < 0 ? text.length : j; substitute(text.slice(i + 1, stop), '`…`'); i = stop + 1; continue }
    if ((c === '<' || c === '>') && text[i + 1] === '(') { end(); const r = readBalanced(text, i + 2); tokens.push({ t: 'w', v: `${c}(…)`, dyn: true, subs: [r.inner], proc: true }); i = r.end; continue }
    if (c === '$') { start(); if (/[A-Za-z_{@*#?!$0-9]/.test(text[i + 1] ?? '')) word.dyn = true; word.v += c; i++; continue }
    if (c === '\n') {
      end(); tokens.push({ t: 'op', v: '\n' }); i++
      while (docs.length) { // here-document bodies follow the line that opened them
        const { delimiter, strip } = docs.shift(), lines = []
        while (i < text.length) {
          const j = text.indexOf('\n', i), stop = j < 0 ? text.length : j, line = text.slice(i, stop)
          i = stop + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
          lines.push(line)
        }
        tokens.push({ t: 'doc', v: lines.join('\n') })
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { end(); i++; continue }
    if (c === '#' && !word) { const j = text.indexOf('\n', i); i = j < 0 ? text.length : j; continue }
    if (three === '<<<') { end(); tokens.push({ t: 'op', v: '<<<' }); i += 3; continue }
    if (two === '<<') {
      end(); const strip = text[i + 2] === '-'; i += strip ? 3 : 2
      while (text[i] === ' ' || text[i] === '\t') i++
      let delimiter = ''
      while (i < text.length && !/[\s;&|<>()]/.test(text[i])) { if (text[i] !== "'" && text[i] !== '"' && text[i] !== '\\') delimiter += text[i]; i++ }
      tokens.push({ t: 'op', v: '<<' }); docs.push({ delimiter, strip }); continue
    }
    if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
      if (word && /^\d+$/.test(word.v) && !word.dyn) word = null // a file descriptor number
      end()
      let op = c; i++
      if (c === '&') { op = '&>'; i++ }
      if (text[i] === '>' || text[i] === '&' || (c === '<' && text[i] === '>')) { op += text[i]; i++ }
      if (op.endsWith('&') && /[0-9-]/.test(text[i] ?? '')) { i++; tokens.push({ t: 'op', v: 'dup' }); continue } // 2>&1, >&-: no file
      tokens.push({ t: 'op', v: 'redir' }); continue
    }
    if (two === '&&' || two === '||' || two === '|&' || two === ';;') { end(); tokens.push({ t: 'op', v: two === '|&' ? '|' : two === ';;' ? ';' : two }); i += 2; continue }
    if (c === ';' || c === '&' || c === '|') { end(); tokens.push({ t: 'op', v: c }); i++; continue }
    if (c === '(' && !word) { parens++; tokens.push({ t: 'op', v: c }); i++; continue }
    if (c === ')' && (parens > 0 || !word)) { end(); if (parens > 0) parens--; tokens.push({ t: 'op', v: c }); i++; continue }
    start(); word.v += c; i++
  }
  end()
  return tokens
}

/**
 * parseShell(text) → the simple commands in order:
 *   { words: [{ v, dyn, subs }], redirects: [{ target, dyn }], stdin: [text], heredoc: boolean, pipedFrom: index | null, group: depth, scope: 'open'|'close'|undefined }
 * Subshell boundaries are kept as { scope: 'open' } / { scope: 'close' } entries so a caller can restore the working directory.
 */
export function parseShell(text) {
  const tokens = lexShell(text)
  const out = []
  let cur = null, pipeFrom = null, pendingRedirect = false, pendingString = false, pendingDoc = 0
  const fresh = () => ({ words: [], redirects: [], stdin: [], heredoc: false, pipedFrom: null })
  const finish = (piped = false) => {
    if (cur && (cur.words.length || cur.stdin.length || cur.redirects.length)) {
      cur.pipedFrom = pipeFrom
      out.push(cur)
      pipeFrom = piped ? out.length - 1 : null
    } else if (!piped) pipeFrom = null
    cur = null
  }
  for (const token of tokens) {
    if (out.length >= SHELL_PARSE_LIMITS.commands) break
    if (token.t === 'doc') { // the body of the oldest open here-document, for the command that opened it
      const owner = [...out].reverse().find(entry => entry.heredocOpen > 0)
      if (owner) { owner.stdin.push(token.v); owner.heredocOpen--; if (!owner.heredocOpen) delete owner.heredocOpen }
      continue
    }
    if (token.t === 'op') {
      if (token.v === 'redir') { pendingRedirect = true; continue }
      if (token.v === 'dup') continue
      if (token.v === '<<<') { pendingString = true; continue }
      if (token.v === '<<') { cur ??= fresh(); cur.heredoc = true; pendingDoc++; continue }
      const docs = pendingDoc; pendingDoc = 0
      if (cur && docs) cur.heredocOpen = docs
      if (token.v === '|') { finish(true); continue }
      if (token.v === '(') { finish(); out.push({ scope: 'open' }); continue }
      if (token.v === ')') { finish(); out.push({ scope: 'close' }); continue }
      finish(); continue
    }
    cur ??= fresh()
    if (pendingRedirect) { cur.redirects.push({ target: token.v, dyn: token.dyn, subs: token.subs }); pendingRedirect = false; continue }
    if (pendingString) { cur.stdin.push(token.v); cur.hereString = true; pendingString = false; if (token.subs.length) cur.words.push({ v: '', dyn: true, subs: token.subs, hidden: true }); continue }
    // reserved words that only shape control flow: the command after them is what runs
    if (!cur.words.length && ['{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'fi', 'done', 'esac'].includes(token.v) && !token.dyn) continue
    cur.words.push(token)
  }
  if (cur && pendingDoc) cur.heredocOpen = pendingDoc
  finish()
  for (const entry of out) delete entry.heredocOpen
  return out
}
