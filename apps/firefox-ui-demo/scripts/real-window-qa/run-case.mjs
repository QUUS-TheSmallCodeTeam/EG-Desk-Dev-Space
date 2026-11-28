// Round b: run one case end to end in the real window and append one JSON line to evidence/b-live/matrix.jsonl. Usage: node run-case.mjs <caseId> <Claude|Codex> [rep]
import { execFileSync, spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const Q = path.dirname(fileURLToPath(import.meta.url)), D = process.env.EGDESK_APP_DIR || path.resolve(Q, '../..'), OUT = process.env.EGDESK_QA_OUT || '/tmp/egdesk-real-window-qa', N = process.env.NODE || process.execPath
const [, , id, engine = "Codex", rep = "1"] = process.argv
const { CASES } = await import(`${Q}/${String(id).startsWith('rws-') ? 'cases-rws' : 'cases'}.mjs`); if (!CASES[id]) throw new Error('no case ' + id)
// data: URL fixtures are rejected by the EG-Desk fixture-QA policy (QA_POLICY_UNVERIFIED): write them to $EGDESK_QA_OUT/fixtures and serve them as http://127.0.0.1:<port>/<file> (default 8770, EGDESK_QA_FIXTURE_PORT). Cases without data: urls are untouched.
const { rewriteFixtureUrls, spawnFixtureServer } = await import(`${Q}/fixture-server.mjs`); const FX = `${OUT}/fixtures`; const fx = rewriteFixtureUrls(CASES[id], id, { dir: FX }); const c = fx.c
const fxServer = fx.files.length ? await spawnFixtureServer({ dir: FX, node: N }) : null; const stopFx = async () => { try { await fxServer?.stop() } catch {} }; process.on('exit', () => { try { fxServer?.stop() } catch {} })
const sh = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { cwd: (cmd === N && args[0] === "scripts/egdesk-turn-timeline.mjs") ? D : Q, encoding: 'utf8', timeout: opts.timeout ?? 200000 }).trim() } catch (e) { return String(e.stdout || '') + ' ERR ' + String(e.message).slice(0, 120) } }
const evalIn = (card, expr) => { const out = sh(N, ['page-eval.mjs', card, expr]); try { return JSON.parse(out) } catch { return { error: out.slice(0, 160) } } }
const kstIso = () => new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')
const go = (card, url, title = '') => { const r = sh(N, ['go-card.mjs', card, url, title]); return /"ok":true/.test(r) }
const rec = { case: /^\d+$/.test(id) ? Number(id) : id, name: c.name, engine, rep: String(rep), at: new Date().toTimeString().slice(0, 8), setup: true }
rec.setup = go(c.card, c.url, c.title || '') && (!c.then || go(c.card, c.then, c.title || '')) && (!c.also || go(c.also.card, c.also.url, ''))
const EXPECT = {}; for (const [k, expr] of Object.entries(c.expect || {})) EXPECT[k] = evalIn(c.card, expr).value
sh('bash', ['-c', `sleep 1.5; ./new-dm-grant.sh ${c.card} ${engine} >/dev/null`]); if (c.also) sh('bash', ['./grant-card.sh', c.also.card])
if (c.person === 'touch-card') sh(N, ['mn.mjs', 'exec', 'const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.getAttribute("title")||b.textContent||"").trim()==="열린 창 전체 보기" && b.getBoundingClientRect().width>0); b?.click(); return !!b', '100'])
sh('sleep', ['5']); const T0 = kstIso()
let helper = null
if (c.person === 'allow-site') helper = spawn('bash', ['./allow-site.sh', c.card, '110'], { cwd: Q, stdio: ['ignore', fs.openSync('/tmp/egd-case-helper.log', 'w'), 'ignore'] })
if (c.person === 'touch-card') helper = spawn('bash', ['-c', `sleep 3.5; P=$(${N} mn.mjs exec 'const b=document.getElementById("${c.card}")._browserControls.toolBrowser(); const r=b.getBoundingClientRect(); return Math.round(r.right-Math.max(8,r.width*0.08))+" "+Math.round(r.top+r.height*0.55)' 100 | tr -d '"'); echo "touch at $P"; ${N} click.mjs $P`], { cwd: Q, stdio: ['ignore', fs.openSync('/tmp/egd-case-helper.log', 'w'), 'ignore'] })
if (c.person === 'pause-card') helper = spawn('bash', ['./pause-card.sh', c.card, '1.5'], { cwd: Q, stdio: ['ignore', fs.openSync('/tmp/egd-case-helper.log', 'w'), 'ignore'] })
const t1 = Date.now(); rec.track = sh('bash', ['./track.sh', c.msg, c.card, '150']).split('\n').filter(l => /^end|^\+/.test(l)).slice(-1)[0]?.slice(0, 40); rec.idle = sh(N, ["wait-idle.mjs", "150"], { timeout: 170000 }); rec.wallSec = Math.round((Date.now() - t1) / 100) / 10
if (c.follow) {
  sh('sleep', ['6']); for (const [k, expr] of Object.entries(c.expectAfterFirst || {})) EXPECT[k] = evalIn(c.card, expr).value
  if (c.person === 'allow-site-follow') helper = spawn('bash', ['./allow-site.sh', c.card, '110'], { cwd: Q, stdio: ['ignore', fs.openSync('/tmp/egd-case-helper.log', 'w'), 'ignore'] })
  const t2 = Date.now(); const out2 = sh('bash', ['./track.sh', c.follow, c.card, '150']); rec.send2 = out2.split('\n').slice(0, 2).join(' | ').slice(0, 200); rec.track2 = out2.split('\n').filter(l => /^end|^\+/.test(l)).slice(-1)[0]?.slice(0, 40); rec.idle2 = sh(N, ["wait-idle.mjs", "150"], { timeout: 170000 }); rec.wallSec2 = Math.round((Date.now() - t2) / 100) / 10
}
sh('sleep', ['7']); try { helper?.kill() } catch {} rec.helper = fs.existsSync('/tmp/egd-case-helper.log') && helper ? fs.readFileSync('/tmp/egd-case-helper.log', 'utf8').replace(/\s+/g, ' ').slice(0, 120) : ''
rec.expect = EXPECT; rec.checks = []
const sub = expr => expr.replace(/EXPECT\.(\w+)/g, (_, k) => JSON.stringify(EXPECT[k] ?? null))
for (const expr of c.checks || []) { const r = evalIn(c.card, sub(expr)); rec.checks.push({ expr: expr.slice(0, 60), ok: r.value === true, got: r.error ? r.error.slice(0, 60) : r.value }) }
for (const expr of c.alsoChecks || []) { const r = evalIn(c.also.card, sub(expr)); rec.checks.push({ expr: 'also:' + expr.slice(0, 55), ok: r.value === true, got: r.error ? r.error.slice(0, 60) : r.value }) }
if (c.anyCard) { const uris = sh(N, ['mn.mjs', 'exec', 'return [...document.querySelectorAll(".egd-browser-card")].map(c=>{ try { return c.id+" "+c._browserControls.toolBrowser().currentURI.spec } catch { return c.id+" ?" } })', '3000']); rec.checks.push({ expr: 'anyCard ' + c.anyCard, ok: uris.includes(c.anyCard), got: (uris.match(new RegExp('egd-browser-card-\\d+ [^"]*' + c.anyCard.replace(/\//g, '\\/'))) || [''])[0] }) }
const chat = sh(N, ['read-chat.mjs', '2500']); const lastMsg = chat.slice(Math.max(0, chat.lastIndexOf(c.follow || c.msg)))
if (c.answerHas) { const want = String(EXPECT[c.answerHas.replace('EXPECT.', '')] ?? ''); rec.checks.push({ expr: 'answer has ' + want.slice(0, 40), ok: !!want && lastMsg.includes(want.slice(0, 20)), got: '' }) }
if (c.answerRe) rec.checks.push({ expr: 'answer ~ ' + c.answerRe, ok: new RegExp(c.answerRe).test(lastMsg), got: '' })
if (c.answerNotRe) rec.checks.push({ expr: 'answer !~ ' + c.answerNotRe.slice(0, 40), ok: !new RegExp(c.answerNotRe).test(lastMsg.replace(/\s+/g, ' ').replace(/.*?(Codex|Claude) /, '')), got: '' })
rec.steps = (lastMsg.match(/브라우저 작업[^]*?(?=[A-Z] (Codex|Claude) |$)/) || [''])[0].replace(/\s+/g, ' ').slice(0, 300)
rec.answer = lastMsg.replace(/\s+/g, ' ').replace(/.*?(Codex|Claude) /, '').slice(0, 220)
rec.falseFail = /실패/.test(rec.steps)
const rows = sh(N, ['scripts/egdesk-turn-timeline.mjs', '--since', T0, '--browser', '--calls', `${OUT}/calls.json`, '--row'], { timeout: 60000 }).split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const lastThread = rows.length ? rows[rows.length - 1].thread : null
rec.rows = rows.filter(r => r.thread === lastThread)
rec.turns = rec.rows.map(r => `${r.thread}#${r.turn} ${r.engine} total ${r.totalSec}s engine ${r.engineSegments}/${r.engineSec}s tools e${r.toolsEngineDirect}/d${r.toolsEngineDelegated}/x${r.toolsDecisionDirect} fail ${r.browserFailures} wait ${r.humanWaitSec}s`)
const sm = rec.steps.match(/결정 모델 (\d+)단계(?: · ([\d.]+)초)?/); rec.decisionFromSteps = sm ? { steps: Number(sm[1]), sec: sm[2] ? Number(sm[2]) : null } : null
rec.totalSec = rec.rows.reduce((t, r) => t + (r.totalSec || 0), 0)
rec.pass = rec.setup && rec.checks.length > 0 && rec.checks.every(x => x.ok)
fs.mkdirSync(`${OUT}`, { recursive: true }); fs.appendFileSync(`${OUT}/matrix.jsonl`, JSON.stringify(rec) + '\n')
console.log(`${rec.pass ? 'PASS' : 'FAIL'} case ${id} ${c.name} ${engine}#${rep} | ${rec.checks.map(x => (x.ok ? 'ok' : 'NO') + ':' + x.expr.slice(0, 28) + (x.ok ? '' : '=' + JSON.stringify(x.got).slice(0, 40))).join(' ; ')}`)
console.log(`   turns: ${rec.turns.join(' || ')} | decision(steps line): ${JSON.stringify(rec.decisionFromSteps)}`); console.log(`   steps: ${rec.steps.slice(0, 220)}`); console.log(`   answer: ${rec.answer.slice(0, 160)}`)
await stopFx()
