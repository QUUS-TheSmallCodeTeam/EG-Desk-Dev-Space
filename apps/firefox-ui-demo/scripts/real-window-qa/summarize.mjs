// Summarize final-matrix rows (rep starting with F): per case x engine pass count, median total, median decision steps sec (steps line), median engine segments.
import fs from 'node:fs'
const rows = fs.readFileSync((process.env.EGDESK_QA_OUT || '/tmp/egdesk-real-window-qa') + '/matrix.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => String(r.rep).startsWith(process.argv[2] || 'F'))
const med = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const by = new Map(); for (const r of rows) { const k = `${r.case}|${r.engine}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r) }
const out = []; for (const [k, rs] of [...by.entries()].sort((a, b) => Number(a[0].split('|')[0]) - Number(b[0].split('|')[0]) || a[0].localeCompare(b[0]))) {
  const [c, e] = k.split('|'); const pass = rs.filter(r => r.pass).length
  out.push({ case: Number(c), name: rs[0].name, engine: e, runs: rs.length, pass, medTotal: med(rs.map(r => r.totalSec)), medEngineSegs: med(rs.map(r => r.rows?.reduce((t, x) => t + (x.engineSegments || 0), 0))), medDecision: med(rs.map(r => r.decisionFromSteps?.sec)), falseFail: rs.filter(r => r.falseFail).length })
}
if (process.argv[3] === 'json') console.log(JSON.stringify(out)); else for (const o of out) console.log(`${String(o.case).padStart(2)} ${o.name.padEnd(14)} ${o.engine.padEnd(6)} ${o.pass}/${o.runs}  total ${o.medTotal?.toFixed?.(1) ?? '-'}s  engineSegs ${o.medEngineSegs ?? '-'}  decision ${o.medDecision ?? '-'}s  실패표시 ${o.falseFail}`)
