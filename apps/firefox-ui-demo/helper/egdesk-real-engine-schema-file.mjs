// c29: scripts/real-engine/real-engine-script.schema.json is a PURE FUNCTION of the registrations (the script format's own schema plus every lane's registered fragment).
// Never hand-merge it: after a merge conflict, or after registering a key, run `node scripts/real-engine/regenerate-schema.mjs`; a test regenerates it and compares the text.
// The rendering is canonical (object keys sorted, arrays in their order, two-space indent, one trailing newline), so two lanes adding different keys change different lines.
export const SCHEMA_FILE = 'scripts/real-engine/real-engine-script.schema.json'

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value

export const renderSchemaFile = schema => `${JSON.stringify(sorted(JSON.parse(JSON.stringify(schema))), null, 2)}\n`
