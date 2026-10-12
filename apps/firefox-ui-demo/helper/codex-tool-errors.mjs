// Provider exceptions may contain raw page text, form values or tool payloads.
// Only fixed, reviewed classifications cross the UI/native/history boundary.
const BROWSER_CODES = new Set([
  'BROWSER_ACTION_UNVERIFIED', 'BROWSER_BINDING_EXISTS', 'BROWSER_BINDING_FORBIDDEN',
  'BROWSER_BINDING_STALE', 'BROWSER_CALL_ID_REQUIRED', 'BROWSER_CALL_ID_REUSED',
  'BROWSER_CALL_LIMIT', 'BROWSER_CARD_BUSY', 'BROWSER_CARD_NOT_SELECTED',
  'BROWSER_INTERACTION_NOT_GRANTED', 'BROWSER_OBSERVATION_STALE',
  'BROWSER_OBSERVATION_UNAVAILABLE', 'BROWSER_OUTCOME_UNKNOWN',
  'BROWSER_OWNER_CHANGED', 'BROWSER_OWNER_REQUIRED', 'BROWSER_RUN_ENDED',
  'BROWSER_TARGET_STALE', 'BROWSER_UI_PROTOCOL', 'BROWSER_UI_TIMEOUT',
  'BROWSER_UI_DISCONNECTED', 'BROWSER_UI_UNAVAILABLE', 'BROWSER_UI_BUSY',
  'BROWSER_UI_RESPONSE_STALE', 'INVALID_BROWSER_SELECTION', 'INVALID_BROWSER_TOOL',
  'BROWSER_TOOL_FAILED', 'BROWSER_RESET_PENDING', 'BROWSER_TOOLS_UNAVAILABLE',
  'BROWSER_POLICY_REQUIRED',
  'BROWSER_FIXTURE_REQUIRED', 'BROWSER_FIXTURE_UNAVAILABLE',
  'BROWSER_FIXTURE_SCOPE', 'BROWSER_FIXTURE_ATTESTATION_FAILED',
])
const CONTEXT_CODES = new Set([
  'ACCOUNT_CHANGED', 'CONTEXT_CHANGED', 'CONTEXT_FORBIDDEN',
  'CONTEXT_PERMISSION_REQUIRED', 'CONTEXT_TOOLS_UNAVAILABLE',
  'IDENTITY_REQUIRED', 'INVALID_BRIEFING', 'INVALID_BRIEFING_TARGET',
  'INVALID_CONTEXT', 'INVALID_CONTEXT_TOOL', 'NATIVE_SCHEMA_MISMATCH',
  'PACKET_CORRUPT', 'READ_CANCELLED',
  'READER_BUSY', 'READER_CONFIGURATION_MISMATCH', 'READER_CONFIGURATION_REQUIRED',
  'READER_EVENT_LIMIT', 'READER_FAILED', 'READER_INVALID_CITATION',
  'READER_INVALID_PACKET', 'READER_ISOLATION_UNAVAILABLE', 'READER_OFFLINE',
  'READER_OUTPUT_LIMIT', 'READER_SCOPE_VIOLATION', 'READER_START_FAILED',
  'READER_STOP_PENDING', 'READER_TIMEOUT',
])

export function classifyPublicToolError(error, { browser = false, context = false } = {}) {
  if (context) return {
    code: CONTEXT_CODES.has(error?.code) ? error.code : 'TOOL_PROVIDER_FAILED',
    message: 'Context access was rejected or unavailable; its raw diagnostic was withheld.',
  }
  if (!browser) return { code: 'TOOL_PROVIDER_FAILED', message: 'A tool provider failed; its raw diagnostic was withheld.' }
  const code = BROWSER_CODES.has(error?.code) ? error.code : 'BROWSER_TOOL_FAILED'
  if (code === 'BROWSER_UI_TIMEOUT' || code === 'BROWSER_OUTCOME_UNKNOWN') return { code, message: 'Browser action outcome is unknown; inspect the Card before retrying.' }
  if (code === 'BROWSER_ACTION_UNVERIFIED') return { code, message: 'Browser action postcondition was not verified; do not retry blindly.' }
  return { code, message: 'Browser tool request was rejected; inspect the selected Card and Run state.' }
}
