#!/usr/bin/env node
// Writes scripts/real-engine/real-engine-script.schema.json from the registrations (see helper/egdesk-real-engine-schema-file.mjs). --check: change nothing, exit 1 when the file is stale.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REAL_ENGINE_SCRIPT_SCHEMA } from '../../helper/egdesk-real-engine-script.mjs'
import { SCHEMA_FILE, renderSchemaFile } from '../../helper/egdesk-real-engine-schema-file.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = path.join(app, SCHEMA_FILE), text = renderSchemaFile(REAL_ENGINE_SCRIPT_SCHEMA)
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
if (process.argv.includes('--check')) { console.log(current === text ? 'schema file is current' : 'schema file is STALE: run node scripts/real-engine/regenerate-schema.mjs'); process.exit(current === text ? 0 : 1) }
if (current !== text) fs.writeFileSync(file, text)
console.log(current === text ? 'schema file unchanged' : 'schema file written')
