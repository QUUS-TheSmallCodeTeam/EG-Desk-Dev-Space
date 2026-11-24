#!/usr/bin/env node
// PreToolUse command hook for Codex (prototype, c13). NOT installed anywhere: see scripts/codex-hooks/README.md.
// Reads one JSON object on stdin, writes nothing or the deny shape on stdout (helper/egdesk-gate-hook-core.mjs). No dependencies.
import { runGateHook } from '../helper/egdesk-gate-hook-core.mjs'
const chunks = []
let size = 0
for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) break; chunks.push(chunk) }
const out = await runGateHook({ stdin: Buffer.concat(chunks).toString('utf8'), env: process.env })
if (out.stdout) process.stdout.write(out.stdout)
process.exitCode = out.exitCode
