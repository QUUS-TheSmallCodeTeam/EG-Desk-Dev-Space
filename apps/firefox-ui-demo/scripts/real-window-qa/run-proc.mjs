// Round g (L62): run Browser-procedure QA cases P1..P7 in the real window. Usage: node run-proc.mjs <P1..P7|all> [rep]
// Appends one JSON line per case to $EGDESK_QA_OUT/matrix-proc.jsonl. Engine: $EGDESK_QA_ENGINE (default Codex). Bridge: $EGDESK_BRIDGE (default http://127.0.0.1:39218).
// If /v1/state has no capabilities.browserProcedures, prints a skip line and exits 0 (nothing is touched). Needs a running EG-Desk: Main runs this after integration.
import { execFileSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const Q = path.dirname(fileURLToPath(import.meta.url)), OUT = process.env.EGDESK_QA_OUT || '/tmp/egdesk-real-window-qa', N = process.env.NODE || process.execPath
const BRIDGE = process.env.EGDESK_BRIDGE || 'http://127.0.0.1:39218', ENGINE = process.env.EGDESK_QA_ENGINE || 'Codex'
const [, , which = 'all', rep = '1'] = process.argv
const P = await import(`${Q}/cases-proc.mjs`); const { CASES, CASE_IDS } = P
const ids = which === 'all' ? CASE_IDS : [which]; for (const id of ids) if (!CASES[id]) { console.error('no case ' + id + ' (have ' + CASE_IDS.join(' ') + ')'); process.exit(2) }
const http = async (method, p, body) => { try { const r = await fetch(BRIDGE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json() } catch {} return { status: r.status, body: j } } catch (e) { return { status: 0, body: { error: String(e.message) } } } }
const state = (await http('GET', '/v1/state')).body
if (!P.hasProcedureCapability(state)) { console.log(P.SKIP_MESSAGE); process.exit(0) }
const { claimsPositively } = await import(`${Q}/answer-check.mjs`); const { rewriteFixtureUrls, spawnFixtureServer } = await import(`${Q}/fixture-server.mjs`)
const FX = `${OUT}/fixtures`, fxServer = await spawnFixtureServer({ dir: FX, node: N }); process.on('exit', () => { try { fxServer?.stop() } catch {} })
const sh = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { cwd: Q, encoding: 'utf8', timeout: opts.timeout ?? 200000 }).trim() } catch (e) { return String(e.stdout || '') + ' ERR ' + String(e.message).slice(0, 120) } }
const evalIn = (card, expr) => { const out = sh(N, ['page-eval.mjs', card, expr]); try { return JSON.parse(out) } catch { return { error: out.slice(0, 160) } } }
const go = (card, url) => /"ok":true/.test(sh(N, ['go-card.mjs', card, url, '']))
const asPlain = s => s.replace(/\s+/g, ' ').replace(/.*?(Codex|Claude) /, '')
const kstIso = () => new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')

async function runCase(id) {
  const fx = rewriteFixtureUrls(CASES[id], 'proc-' + id, { dir: FX }), c = fx.c
  const rec = { case: id, name: c.name, engine: ENGINE, rep: String(rep), at: kstIso(), phases: [], checks: [] }; const ctx = { url: c.url, name: null, seed: null, draft: null, proc: null, thread: null, dm: false, saved: [] }
  const fail = (expr, got) => rec.checks.push({ expr: String(expr).slice(0, 70), ok: false, got })
  const ok = (expr, got = '') => rec.checks.push({ expr: String(expr).slice(0, 70), ok: true, got })
  const grouped = {}; const mark = (g, v) => { if (g) grouped[g] = (grouped[g] ?? true) && v }
  const seedProc = async () => { const name = `${c.seed.name} ${Date.now().toString(36)}`; const r = await http('POST', '/v1/procedures', P.resolveSeed(c.seed, ctx.url, name)); const p = r.body?.procedure ?? r.body; if (r.status >= 300 || !p?.id) throw new Error('seed save ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120)); ctx.seed = p; ctx.proc = p; ctx.name = p.name; ctx.saved.push(p.id); return p }
  try {
    for (const ph of c.phases) {
      const at = ph.do; rec.phases.push(at)
      if (at === 'goto') { const u = ph.to === 'then' ? c.then : c.url; ctx.url = c.url; if (!go(c.card, u)) { fail('goto ' + ph.to, 'go-card failed'); break } }
      else if (at === 'seed') { await seedProc() }
      else if (at === 'chat') {
        if (!ctx.dm) { sh('bash', ['-c', `sleep 1.5; ./new-dm-grant.sh ${c.card} ${ENGINE} >/dev/null`]); sh('sleep', ['5']); ctx.dm = true }
        const msg = P.fillTemplate(ph.msg, { NAME: ctx.name || '' }); sh('bash', ['./track.sh', msg, c.card, '150']); sh(N, ['wait-idle.mjs', '150'], { timeout: 170000 }); sh('sleep', ['4'])
        const chat = sh(N, ['read-chat.mjs', '2500']); const at2 = chat.lastIndexOf(msg), vis = at2 >= 0 || chat.lastIndexOf(msg.slice(0, 12)) >= 0, last = vis ? chat.slice(at2 >= 0 ? at2 : chat.lastIndexOf(msg.slice(0, 12))) : ''
        rec[`answer_${ph.id || rec.phases.length}`] = asPlain(last).slice(0, 220); if (!vis) fail('message visible in chat', ''); 
        if (ph.answerRe) { const v = new RegExp(ph.answerRe).test(last); mark(ph.id, v); if (ph.id && c.anyOf?.includes(ph.id)) {} else rec.checks.push({ expr: 'answer ~ ' + ph.answerRe.slice(0, 40), ok: v, got: '' }) }
        if (ph.answerNotRe) { const v = !claimsPositively(asPlain(last), ph.answerNotRe); rec.checks.push({ expr: 'no positive claim ~ ' + ph.answerNotRe.slice(0, 40), ok: v, got: '' }) }
        const st = (await http('GET', '/v1/state')).body, th = (await http('GET', '/chat/history/threads')).body; ctx.thread = process.env.EGDESK_QA_THREAD || P.pickThreadId(st, th) || ctx.thread
      }
      else if (at === 'capture') {
        if (!ctx.thread) { fail('capture', 'no clientThreadId found (set EGDESK_QA_THREAD)'); break }
        const r = await http('POST', '/v1/procedures/capture', { clientThreadId: ctx.thread, cardId: c.card, name: ph.name }); ctx.draft = r.body?.draft; rec.captureStatus = r.status
        if (!ctx.draft) { fail('capture draft', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); break }
        ctx.name = ctx.draft.name
      }
      else if (at === 'save') { const r = await http('POST', '/v1/procedures', ctx.draft); const p = r.body?.procedure ?? r.body; if (r.status >= 300 || !p?.id) { fail('save', 'HTTP ' + r.status); break } ctx.proc = p; ctx.saved.push(p.id); const l = await http('GET', '/v1/procedures'); const list = l.body?.procedures ?? l.body; const inList = Array.isArray(list) && list.some(x => x.id === p.id); rec.checks.push({ expr: 'saved procedure listed', ok: inList, got: '' }) }
      else if (at === 'get') { const r = await http('GET', '/v1/procedures/' + ctx.proc.id); const p = r.body?.procedure ?? r.body; if (r.status !== 200 || !p?.id) { fail('get', 'HTTP ' + r.status); break } ctx.proc = p }
      else if (at === 'put') {
        const cur = (await http('GET', '/v1/procedures/' + ctx.proc.id)).body; const base = cur?.procedure ?? cur; const next = P.applyEdits(base, ph.edits)
        const r = await http('PUT', '/v1/procedures/' + ctx.proc.id, next); if (r.status >= 300) { fail('put', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); break } ctx.name = next.name
      }
      else if (at === 'eval') for (const e of ph.checks) { const r = evalIn(c.card, e); const v = r.value === true; mark(ph.id, v); if (ph.id && c.anyOf?.includes(ph.id)) {} else rec.checks.push({ expr: e.slice(0, 60), ok: v, got: r.error ? r.error.slice(0, 60) : r.value }) }
      else if (at === 'proc') { const p = ph.on === 'draft' ? ctx.draft : ctx.proc; for (const e of ph.checks) { const r = P.evalProcCheck(e, p, ctx); rec.checks.push({ expr: 'proc: ' + e.slice(0, 60), ok: r === true, got: r === true ? '' : r }) } }
    }
    if (c.anyOf) { const v = c.anyOf.some(g => grouped[g] === true); rec.checks.push({ expr: 'anyOf ' + c.anyOf.join('|'), ok: v, got: JSON.stringify(grouped) }) }
  } catch (e) { fail('exception', String(e.message).slice(0, 120)) }
  // cleanup: procedures this run created (keeps the user's store clean); P1's saved copy is deleted too.
  if (!process.env.EGDESK_QA_KEEP) for (const pid of ctx.saved) await http('DELETE', '/v1/procedures/' + pid)
  rec.pass = rec.checks.length > 0 && rec.checks.every(x => x.ok); rec.ended = kstIso()
  fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(`${OUT}/matrix-proc.jsonl`, JSON.stringify(rec) + '\n')
  console.log(`${rec.pass ? 'PASS' : 'FAIL'} ${id} ${c.name} ${ENGINE}#${rep} | ${rec.checks.map(x => (x.ok ? 'ok' : 'NO') + ':' + x.expr.slice(0, 28) + (x.ok ? '' : '=' + JSON.stringify(x.got).slice(0, 40))).join(' ; ')}`)
  return rec.pass
}
let allOk = true; for (const id of ids) allOk = (await runCase(id)) && allOk
try { await fxServer?.stop() } catch {}
process.exit(0)
