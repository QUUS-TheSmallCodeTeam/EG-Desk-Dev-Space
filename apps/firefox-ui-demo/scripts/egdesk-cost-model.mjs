#!/usr/bin/env node
// node scripts/egdesk-cost-model.mjs --journey <journey results.json> --rows <evidence rows.json> [--out <file>]
// Prints the per-feature cost model (helper/egdesk-cost-model.mjs). Reads two files, writes at most --out, sends nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildCostModel } from '../helper/egdesk-cost-model.mjs'
const args = process.argv.slice(2), valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
const journeyFile = valueOf('--journey'), rowsFile = valueOf('--rows'), out = valueOf('--out')
if (!journeyFile || !rowsFile) { console.error('usage: egdesk-cost-model.mjs --journey <journey results.json> --rows <rows.json> [--out <file>]'); process.exit(2) }
const model = buildCostModel({ journey: JSON.parse(readFileSync(journeyFile, 'utf8')), requests: JSON.parse(readFileSync(rowsFile, 'utf8')).requests })
const text = JSON.stringify(model, null, 1)
if (out) writeFileSync(out, text + '\n'); else console.log(text)
