#!/usr/bin/env node
// PreToolUse command hook for Codex (prototype, c13). NOT installed anywhere: see scripts/codex-hooks/README.md.
// Reads one JSON object on stdin, writes nothing or the deny shape on stdout (helper/egdesk-gate-hook-core.mjs). No dependencies.
import { gateHookMain } from '../helper/egdesk-gate-hook-core.mjs'
await gateHookMain(process)
