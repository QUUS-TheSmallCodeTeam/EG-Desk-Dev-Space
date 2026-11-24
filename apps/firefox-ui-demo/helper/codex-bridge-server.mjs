import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fingerprintNativeExecutable } from './codex-native-schema-probe.mjs'
import { createCodexProfileAppServers } from './codex-profile-app-servers.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { accountAccessState, normalizeNativeAuth, publicAuthIdentityKey, publicPlanType, usageRefreshDue } from './codex-auth-state.mjs'
import { usageDisplay } from './codex-account-usage.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { CODEX_ENGINE_PROFILE_ID, codexDeviceLoginPatch, codexLoginInProgressResponse, codexLoginMode, codexLoginStartParams, createCodexEngineAdapter, describeCodexEngine, isStaleLoginFailure } from './codex-engine-adapter.mjs'
import { EngineRegistry, createEngineStatusEmitter } from './engine-registry.mjs'
import { claudeLoginTerminalCommand, createClaudeEngineStatus, probeClaudeEngine, resolveClaudeExecutable } from './claude-engine-auth.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createModelCatalogSync } from './codex-model-catalog.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { fixtureBrowserQaFromEnv } from './codex-browser-fixture-qa.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { createAccountAccessTracker, createChatHttpHandler, createComputerControlHttpHandler, createRateLimitSync, createReconnectBackoff, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { bridgeBuildState, expectedOverlayBuild, startBridgeBuild } from './egdesk-bridge-build.mjs'
import { createInheritedMcpSync } from './codex-inherited-mcp.mjs'
import { BoundedSseClient } from './codex-bridge-sse.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'
import { createTerminalRunWatch } from './egdesk-terminal-run-watch.mjs'
import { createTerminalStateWatch } from './egdesk-terminal-state-watch.mjs'
import { createGitTargetInspector } from './egdesk-terminal-git-facts.mjs'
import { createTerminalSessionFactory } from './terminal-platform.mjs'
import { createTerminalHttpHandler } from './terminal-http.mjs'
import { chatError, publicText } from './codex-chat-values.mjs'
import { createHmac, randomBytes } from 'node:crypto'
import * as os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore, appDataDirectory } from './egdesk-context-store.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createProfileHttpHandler } from './egdesk-profile-http.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { createDecisionBudget, createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createDecisionTransport } from './egdesk-decision-transport.mjs'
import { openDecisionCredentialStore } from './egdesk-decision-credential.mjs'
import { openDecisionBudgetStore } from './egdesk-decision-budget-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createTurnMemoryConfig, turnMemoryFlagsFromEnv } from './egdesk-turn-memory-wiring.mjs'
import { createBrowserEntryConfig } from './egdesk-browser-entry-wiring.mjs'
import { createDecisionHttpHandler } from './egdesk-decision-http.mjs'
import { createBoardPresentationHttpHandler } from './egdesk-board-presentation-http.mjs'
import { briefingDeps } from './egdesk-briefing-engine.mjs'
import { createWorkPlacement, createWorkPlacementHttpHandler } from './egdesk-work-placement.mjs'
import { createPresenceMirror, createPresenceMirrorHttpHandler, createRunRequesters, createRunRequesterHttpHandler } from './egdesk-presence-mirror.mjs'
import { createWindowWatch } from './egdesk-heartbeat.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { createMemoryEvidenceHttpHandler } from './egdesk-memory-http.mjs'
import { MAX_ENGINE_PROFILES, openEngineProfiles } from './egdesk-engine-profiles.mjs'
import { createEngineProfilesHttpHandler } from './egdesk-engine-profiles-http.mjs'
import { createDeskHttpHandler } from './egdesk-desk-http.mjs'
import { createPortableHttpHandler } from './egdesk-portable-http.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { createBoardAgentAskHttpHandler } from './egdesk-board-agent-ask-http.mjs'
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport, BOARD_AGENT_DRAFT_INSTRUCTIONS, BOARD_AGENT_DRAFT_REPLY_STYLES } from './egdesk-board-agent-draft.mjs'
import { createBoardAgentDraftConfigReader } from './egdesk-board-agent-draft-config.mjs'
import { createContextAttachmentProvider, createManagedDraftProvider } from './egdesk-portable-providers.mjs'
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { ClaudeReaderClient, estimateClaudeReaderInput } from './egdesk-claude-reader.mjs'
import { createClaudeReaderEvidence } from './egdesk-claude-capacity.mjs'
import { createClaudeProcessBudget } from './egdesk-claude-limits.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { buildCodexAppServerLaunch, inspectNativeCapabilities, preflightOwnedAppServer, resolveCodexExecutable, NATIVE_SCHEMA_VERSION } from './egdesk-native-capabilities.mjs'
import { createEGDeskFileMount, requireEGDeskNodeRuntime } from './egdesk-file-mount.mjs'
import { createSystemResourceMonitor } from './system-resource-monitor.mjs'
import { createLocalCapacity } from './egdesk-local-capacity.mjs'
import { WORKFLOW_OWNER, openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'
import { createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'
import { createAnnotationToolProvider } from './egdesk-annotation-tool-provider.mjs'
import { openOntologyStore } from './egdesk-ontology-store.mjs'
import { createOntologyHttpHandler, ontologyHealth, openBoundOntologyStore, readOntologyProfileBinding } from './egdesk-ontology-http.mjs'
import { inspectSqliteRuntime } from './egdesk-sqlite-runtime.mjs'
import { createHostAgent, resolveHostAgentExecutable } from './egdesk-host-agent.mjs'
import { createHostControl, createHostControlHttpHandler } from './egdesk-host-control.mjs'

// Ignore prerelease variables; do not pass them on in direct bridge launches.
for (const name of Object.keys(process.env)) {
  if (/^EGDESK_BOARD_AGENT_DRAFT_(API_KEY|MODEL)$/i.test(name)) delete process.env[name]
}

const nodeRuntime = requireEGDeskNodeRuntime()

const BRIDGE_PORT = 39218
const APP_SERVER_PORT = 39219
const APP_SERVER_WS_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`
const appServerLaunch = buildCodexAppServerLaunch({ env: process.env, listen: APP_SERVER_WS_URL })
const BRIDGE_PROTOCOL_VERSION = 1
const PROVIDER_ID = 'codex'
// Hash of the helper modules this process loaded, read once at start, so the
// overlay can tell a bridge left running on older source (/v1/state bridge).
const bridgeBuild = startBridgeBuild()

const clients = new Set()

let appServerProcess = null
let appServerSocket = null
let appServerReady = false
let reconnectTimer = null
const appServerBackoff = createReconnectBackoff()
let loginPollTimer = null
let rpc = null
let accountAccessEpoch = 0
let nativeCapabilities = { executable: null, version: null, schemaVersion: NATIVE_SCHEMA_VERSION, schemaMatch: false, experimentalApi: true, dynamicTools: false, readerReadOnly: false, qaReadOnly: false }
let launchConfigBlocked = false
let nativePreflight = {
  status: appServerLaunch.hasOverrides ? 'pending' : 'inherited',
  configuredModel: appServerLaunch.configuredModel, configuredEffort: appServerLaunch.configuredEffort,
  effectiveModel: null, effectiveEffort: null,
}
let memoryIsolation = { status: appServerLaunch.disableMemories ? 'pending' : 'not-requested', feature: 'memories' }

const authState = {
  isLoggedIn: false,
  authMode: null,
  accountId: null,
  accountEmail: null,
  planType: null,
  rateLimits: null,
  identityStatus: 'unknown',
  identityBasis: null,
  lastRefresh: null,
  source: 'app-server',
  statusText: 'Login required',
  loginInProgress: false,
  authSessionId: null,
  authUrl: null,
  verificationUrl: null,
  userCode: null,
  callbackUrl: null,
  loginMode: 'browser',
  requiresOpenaiAuth: true,
  loginError: null,
  accessFailure: null,
}

function broadcast(event, chatProtocol = 0) {
  const payload = `event: codex\ndata: ${JSON.stringify(event)}\n\n`
  for (const client of clients) {
    if (chatProtocol && client.chatProtocol !== chatProtocol) continue
    client.send(payload)
  }
}

function emitAuthStatus() {
  broadcast({
    type: 'auth.status',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    status: authSnapshot(),
    ts: Date.now(),
  })
}

function emitAuthLifecycle(phase, details = {}) {
  broadcast({
    type: 'auth.lifecycle',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    phase,
    status: authSnapshot(),
    details,
    ts: Date.now(),
  })
}

const nativeRespond = (id, result, error) => {
  if (!rpc) throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
  rpc.respond(id, result, error)
}
const dataDir = appDataDirectory()
const sqliteRuntime = inspectSqliteRuntime()
let ontologyBinding = null
let ontologyStore = null
try { ontologyBinding = readOntologyProfileBinding(process.env.EGDESK_FIREFOX_PROFILE) }
catch { console.error('[egdesk-codex-bridge] ontology profile binding unavailable') }

// Only the launcher's verified Firefox profile can select this local DB. A
// failed first migration leaves the baseline and imported data intact for retry.
// An already initialized DB never reads or imports the seed again.
function ensureOntologyStore() {
  if (!ontologyBinding || ontologyStore) return ontologyStore
  try {
    ontologyStore = openBoundOntologyStore({ binding: ontologyBinding, dataDir, openStore: openOntologyStore })
  } catch {
    console.error('[egdesk-codex-bridge] ontology storage unavailable; original data retained')
  }
  return ontologyStore
}
ensureOntologyStore()
const systemResourceMonitor = createSystemResourceMonitor({ profilePath: dataDir })
const localCapacity = createLocalCapacity({ monitor: systemResourceMonitor })
let chatStore = null
let chatStoreError = null
try {
  chatStore = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
} catch (error) {
  chatStoreError = publicText(error?.message || 'Local chat storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local chat storage unavailable:', chatStoreError)
}
// Agent profiles are local data like chat history: a failure leaves Chat and
// the bridge running, and profile routes answer 503.
let profileStore = null
let profileStoreError = null
try {
  profileStore = openProfileStore({ dataDir: path.join(dataDir, 'chat'), ownerHash: 'local-desktop-v1' })
  profileStore.seedTemplates()
} catch (error) {
  profileStoreError = publicText(error?.message || 'Local profile storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local profile storage unavailable:', profileStoreError)
}
// RT-07/CTX-01/CTX-02 Desk recovery journal and saved Board revisions. A
// failure leaves the bridge running; /v1/desk and /v1/boards answer 503 and
// the screen keeps its preference values.
let deskStore = null
let deskStoreError = null
try {
  deskStore = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1' })
} catch (error) {
  deskStoreError = publicText(error?.message || 'Local Desk storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local Desk storage unavailable:', deskStoreError)
}
// CU-01: settings the user chose that outlive a restart (computer control).
// Never throws; a broken file is set aside and logged, and the bridge starts
// with defaults (computerControl.persisted then tells the screen).
const bridgeSettings = openBridgeSettings({ dataDir: path.join(dataDir, 'settings') })
// Decision model (DECISION_MODEL_CONTEXT_SETUP.md): the OpenAI key lives in its
// own 0600 file in the same private settings directory (never in .egdesk
// exports); the mode is the bridge setting decisionContext ('off' unless chosen).
// No local monthly cap until the owner picks one (§5.4). Never throws. The
// month's input-token tally (and a cap, once chosen) is kept in its own 0600
// file beside the key so a restart does not reset the local guard; the key is
// never written there.
const decisionCredentials = openDecisionCredentialStore({ dataDir: path.join(dataDir, 'settings') })
const decisionBudgetStore = openDecisionBudgetStore({ dataDir: path.join(dataDir, 'settings') })
// Content-free threshold-calibration record (canon 5.3): numbers and closed words only, own 0600 file, never exported.
const decisionCalibrationLog = openCalibrationLog({ dataDir: path.join(dataDir, 'settings') })
const decisionBudget = createDecisionBudget({ monthlyInputTokenCap: decisionBudgetStore.state?.cap ?? null, initial: decisionBudgetStore.state,
  onChange: state => { decisionBudgetStore.save(state) } })
const recipientForDecisionKey = (key, endpoint, model) => decisionTopicRecipient(key, decisionCredentials.savedAt(), endpoint, model)
// One keep-alive transport for the single Decisions endpoint (never retries; see egdesk-decision-transport.mjs).
const decisionTransport = createDecisionTransport()
const decisionClient = createDecisionClient({ getApiKey: () => decisionCredentials.getApiKey(), budget: decisionBudget, recipientForKey: recipientForDecisionKey, fetchImpl: decisionTransport.fetch })
const recipientForCodexDecisions = ({ engineId, engineProfileId, ownerKey }) => {
  if (engineId !== 'codex') return null
  const auth = !engineProfileId || engineProfileId === CODEX_ENGINE_PROFILE_ID ? authState : codexProfileServers.snapshot(engineProfileId)?.auth
  if (auth?.isLoggedIn !== true || auth.authMode !== 'chatgpt' || publicAuthIdentityKey(auth) !== ownerKey) return null
  return recipientForDecisionKey(decisionCredentials.getApiKey(), undefined, decisionClient.model)
}
// SUB-11 Engine Profiles: the shared CLI logins plus EG-Desk-owned login
// folders (<appData>/settings/engines/<id>, 0700). Claude runs the active
// one (CLAUDE_CONFIG_DIR); an owned Codex account uses its own app-server.
const engineProfiles = openEngineProfiles({ dataDir: path.join(dataDir, 'settings'), isolatedCodex: true })
const claudeProfileRows = () => engineProfiles.list('claude').map(row => ({ ...row, configDir: row.owned ? engineProfiles.configDir(row.id) : null }))
const claudeProfileEnv = profileId => {
  if (profileId === 'claude-default') return process.env
  const dir = engineProfiles.configDir(profileId)
  if (!dir) throw new Error('Claude account folder unavailable')
  return { ...process.env, CLAUDE_CONFIG_DIR: dir }
}
// RT-06/CHAT-06 workflow runtime (event bus, connected-root watcher, task
// graph). Opened after Chat below. Keep roots registered during construction
// until both the context tracker and workflow watcher can receive them.
let workflow = null
let contexts = null
let acceptingFileRoots = true
const pendingFileRoots = new Map()
const localFiles = createEGDeskFileMount({ dataDir, port: BRIDGE_PORT, onRootRegistered: root => {
  if (!acceptingFileRoots) return
  if (!contexts || !workflow) pendingFileRoots.set(root.rootId, root)
  contexts?.noteRoot(root)
  workflow?.watchRoot(root)
} })
const contextStore = new ImmutableContextStore({
  dataDir,
  managedFileView: localFiles.managedFileView,
  allowedRoots: process.env.EGDESK_CONTEXT_ROOTS ? process.env.EGDESK_CONTEXT_ROOTS.split(path.delimiter).filter(Boolean) : [process.cwd()],
})
const nativeReader = new NativeReaderClient({ request: (method, params) => appServerRequest(method, params), respond: nativeRespond, getOwnerKey: () => publicAuthIdentityKey(authState) })
// Stock get_context_usage supplies partial window/usage metadata, not the
// verified tool-output/estimator and managed-policy evidence strict B3 needs.
// No fixture, model-name table, caller window or Codex metadata is a substitute.
// Wire authoritative exports here when available; ordinary chat/B2 stay ready.
// SUB-09: the parent conversation's native usage + applied MCP output limit
// and the managed-policy/hook inventory (egdesk-claude-capacity). Live only
// with EGDESK_CLAUDE_READER=live until a real subscription round trip is checked.
const claudeProcessBudget = createClaudeProcessBudget()
let claudeReaderEvidence = null
const getClaudeReadCapacity = options => claudeReaderEvidence?.readCapacity(options) ?? null
const getClaudeReaderIsolationProof = options => claudeReaderEvidence?.isolationProof(options) ?? null
let claudeReaderClient = null
const claudeReader = {
  estimateInput: estimateClaudeReaderInput,
  readiness(options) {
    if (!getClaudeReadCapacity(options)) return { ready: false, engineId: 'claude', code: 'ENGINE_CAPACITY_UNKNOWN' }
    return this.client().readiness(options)
  },
  client() {
    if (!claudeReaderClient) {
      const executablePath = resolveClaudeExecutable(process.env)
      if (!executablePath) throw chatError('ENGINE_NOT_INSTALLED', 'Claude Reader executable is unavailable', 409)
      claudeReaderClient = new ClaudeReaderClient({ executablePath, getScope: () => chat.contextAuthority({ engineId: 'claude' }),
        snapshot: () => claudeEngineStatus.snapshot(), getReadCapacity: getClaudeReadCapacity, getIsolationProof: getClaudeReaderIsolationProof,
        processBudget: claudeProcessBudget })
    }
    return claudeReaderClient
  },
  read(options) {
    if (!getClaudeReadCapacity(options)) throw chatError('ENGINE_CAPACITY_UNKNOWN', 'Strict Claude Reader capacity is not verified; no native process was started', 409)
    return this.client().read(options)
  },
  disconnect(options) { return claudeReaderClient?.disconnect(options) },
}
contexts = new ContextRuntime({
  store: contextStore, reader: nativeReader, readers: { claude: claudeReader }, getReadCapacity: getClaudeReadCapacity,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  getAuthority: hints => chat.contextAuthority(hints),
  schemaReady: authority => authority?.engineId === 'claude'
    ? claudeEngine.isReady() && claudeEngine.capabilities().has('dynamicTools')
    : nativeCapabilities.schemaMatch && appServerReady,
})
for (const root of pendingFileRoots.values()) contexts.noteRoot(root)
const browserTransport = new BrowserToolTransport({ getOwnerKey: () => publicAuthIdentityKey(authState) })
// Browser-only transfer generation; restored settings never revive older work.
let browserDecisionGeneration = 0
const browserProvider = createCodexBrowserToolProvider({ transport: browserTransport, getOwnerKey: () => publicAuthIdentityKey(authState), schemaReady: () => nativeCapabilities.qaReadOnly && appServerReady, fixtureQa: fixtureBrowserQaFromEnv(process.env),
  // DECISION_MODEL_CONTEXT_SETUP.md §3.3: egdesk_browser_reflex only with a key and mode 'on'.
  decision: { mode: () => bridgeSettings.decisionContext.mode, configured: () => decisionCredentials.getApiKey() !== null,
    recipient: () => recipientForDecisionKey(decisionCredentials.getApiKey(), undefined, decisionClient.model),
    generation: () => browserDecisionGeneration, client: decisionClient } })
// egdesk_propose_plan on ordinary threads: plans wait for approval in the
// workflow runtime opened below (null until then, so the tool answers unavailable).
const planProvider = createPlanToolProvider({ plans: () => workflow?.plans ?? null, schemaReady: () => nativeCapabilities.schemaMatch && appServerReady })
// CNV-05: egdesk_publish_annotation on ordinary threads (dotted '제안' over a card).
const annotationProvider = createAnnotationToolProvider({ schemaReady: () => nativeCapabilities.schemaMatch && appServerReady })
// The Codex models the signed-in account can choose (model/list, hidden ones
// excluded), read after each ready connection and on every account change;
// null while unknown or signed out. They fill the Codex engines[] row and
// bound /chat/send.
const modelCatalog = createModelCatalogSync({
  request: (method, params) => appServerRequest(method, params),
  ready: () => appServerReady && authState.isLoggedIn,
  identity: () => modelAccountKey(authState),
  onChange: () => engineStatus.check(),
})
const codexProfileServers = createCodexProfileAppServers({
  resolveHome: id => engineProfiles.ownedCodexHome(id),
  // Bind proof to this dedicated process at launch, never borrow the shared
  // RPC, owner or a new binary's contract for an already-running account slot.
  getBoardPeerContract: bin => nativeCapabilities.boardPeerContract && bin === nativeCapabilities.executable
    && fingerprintNativeExecutable(bin) === nativeCapabilities.binaryFingerprint ? nativeCapabilities.boardPeerContract : null,
  onNotification: (id, message) => codexEngine.notify(message, id),
  onServerRequest: (id, message) => codexEngine.serverRequest(message, id),
  onConnection: (id, state) => codexEngine.connection(state, id),
  onChange: () => engineStatus.check(),
})
// Each adapter owns its responses; the chat runtime routes engine RPC IDs.
const codexEngine = createCodexEngineAdapter({
  request: (method, params) => appServerRequest(method, params),
  respond: nativeRespond,
  profiles: codexProfileServers,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  isReady: () => appServerReady,
  getModels: () => modelCatalog.snapshot(),
  getBoardPeerContract: () => appServerReady ? nativeCapabilities.boardPeerContract : null,
  describe: () => describeCodexEngine({
    ready: appServerReady, starting: Boolean(appServerProcess) && !appServerReady, blocked: launchConfigBlocked,
    version: nativeCapabilities.version, versionSupported: nativeCapabilities.version ? nativeCapabilities.schemaMatch : null,
    versionStatus: nativeCapabilities.versionStatus ?? null,
    auth: authState, usage: usageDisplay(authState.rateLimits, Date.now()),
    residentProcesses: (appServerProcess && appServerProcess.exitCode == null ? 1 : 0) + codexProfileServers.residentCount(),
    residentLimit: MAX_ENGINE_PROFILES,
    models: modelCatalog.snapshot(),
    extraProfiles: engineProfiles.list('codex').filter(row => row.owned).map(row => ({ ...row, ...codexProfileServers.snapshot(row.id) })),
  }),
})
// D-S1 (b) (2026-10-24): the installed, unmodified `claude`, one child
// process per conversation over the SDK stdio control channel. Gated by the
// static check below (installed, version range, signed in); D-S2 isolation and
// D-S4 API key confirmation live in the adapter and its transport.
const claudeEngine = createClaudeEngineAdapter({
  snapshot: () => claudeEngineStatus.snapshot(),
  refreshStatus: options => claudeEngineStatus.refresh(options),
  defaultCwd: process.cwd(),
  onStatusChange: () => engineStatus.check(),
  processBudget: claudeProcessBudget,
  profiles: claudeProfileRows,
})
if (process.env.EGDESK_CLAUDE_READER === 'live') claudeReaderEvidence = createClaudeReaderEvidence({ adapter: claudeEngine, snapshot: () => claudeEngineStatus.snapshot() })
const engineRegistry = new EngineRegistry({ defaultEngineId: PROVIDER_ID })
engineRegistry.register(codexEngine)
engineRegistry.register(claudeEngine)
const canAddEngineProfileAndLogin = (id, row = engineRegistry.publicEngines().find(engine => engine.id === id)) =>
  engineProfiles.supportsAddAndLogin(id) && ['ready', 'loginRequired'].includes(row?.status) && row.versionStatus !== 'unsupported'
const publicEngines = () => engineRegistry.publicEngines().map(row => ({ ...row, profileAddAndLogin: canAddEngineProfileAndLogin(row.id, row) }))
// SSE engine.status (design §7): sent whenever a public engines[] row changes
// (connection, sign-in or account change, model list), beside auth.status.
const engineStatus = createEngineStatusEmitter({
  engines: publicEngines,
  emit: event => broadcast(event),
  v: BRIDGE_PROTOCOL_VERSION,
})
// SUB-08/13: static Claude CLI check (`--version`, `auth status --json`) for
// the Claude row: installed, version range, signed-in plan and email. It
// never reads Keychain or credential files. A change re-gates the adapter;
// becoming ready (or not) reaches Chat as a Claude connection change.
const claudeEngineStatus = createClaudeEngineStatus({
  // SUB-11: the static check reads the active profile's login folder.
  getProfileId: () => engineProfiles.active('claude'),
  probe: profileId => probeClaudeEngine({ env: claudeProfileEnv(profileId) }),
  onChange: () => {
    claudeEngine.syncStatus()
    engineStatus.check()
  },
})
// CU-01/02/05: this Mac's control lease behind the fail-closed input gate,
// the observe-only host helper (started when the host-activity view first
// asks) and the activity timeline. Lease events reach chat.noteHostControl.
// No shutdown step: the helper exits on its stdin EOF when the bridge exits.
const hostControl = createHostControl({
  makeAgent: onEvent => createHostAgent({ executable: resolveHostAgentExecutable(), onEvent }),
  onLeaseEvent: event => chat.noteHostControl(event),
  emit: event => broadcast({ ...event, v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, ts: Date.now() }),
})
let memoryEvidenceStore = null
const getMemoryEvidence = () => memoryEvidenceStore ??= new MemoryEvidenceStore({ dataDir, captures: contextStore })
// Advisory turn memory: off unless the bridge setting `turnMemory` is 'advisory'. The adapter and its write store open lazily.
let wikiAdapter = null
// Its internal options come from developer flags (turnMemoryFlagsFromEnv: EGDESK_TURN_MEMORY_ONE_PACKET / _WRITE_TARGET / _CONFIRM), default unchanged.
const turnMemoryConfig = createTurnMemoryConfig({ settings: bridgeSettings, ontologyStore: ensureOntologyStore, deskStore, ...turnMemoryFlagsFromEnv(process.env),
  getAdapter: () => wikiAdapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dataDir, 'settings') }) }) })
// Direct browser entry: developer flag EGDESK_BROWSER_ENTRY=advisory|on, default off (no settings screen entry). It reuses the turn-memory
// snapshot builder and the same adapter/write store; nothing opens while it is off.
const browserEntryConfig = createBrowserEntryConfig({ flag: () => process.env.EGDESK_BROWSER_ENTRY, getAdapter: () => turnMemoryConfig.getAdapter(),
  wiki: args => turnMemoryConfig.wiki(args) })
// The Desk's presence snapshot as the window posts it (same rows the placement runtime reads there). Memory only; the route is off (404)
// unless the developer flag EGDESK_PRESENCE=on is set. Default off.
const presenceMirror = createPresenceMirror()
const handlePresenceMirrorHttp = createPresenceMirrorHttpHandler({ mirror: presenceMirror, enabled: () => process.env.EGDESK_PRESENCE === 'on', port: BRIDGE_PORT })
// Whose task a conversation's run is (another member's presence alias, told by the window; memory only). Same flag, default off.
const runRequesters = createRunRequesters({ presence: presenceMirror })
const handleRunRequesterHttp = createRunRequesterHttpHandler({ requesters: runRequesters, enabled: () => process.env.EGDESK_PRESENCE === 'on', port: BRIDGE_PORT })
const chat = new CodexChatRuntime({
  localCapacity,
  engines: engineRegistry,
  contexts,
  resolveProjectWorkspace: request => localFiles.resolveProjectWorkspace(request),
  resolveRunProjectOrigin: request => localFiles.resolveRunProjectOrigin(request),
  toolProviders: [browserProvider, planProvider, annotationProvider],
  store: chatStore,
  requireStore: true,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  expectedProcessConfiguration: { model: appServerLaunch.configuredModel, effort: appServerLaunch.configuredEffort },
  qaReady: () => nativeCapabilities.qaReadOnly && appServerReady,
  getNativeContractFingerprint: () => nativeCapabilities.contractFingerprint,
  profiles: profileStore,
  emit: event => { broadcast(event, 2); workflow?.onChatEvent(event); hostControl.onChatEvent(event) },
  emitLegacy: event => broadcast(event, 1),
  // CU-01: an MCP call's controlKind also reads the inherited classification
  // (declared below; a Computer Use marker makes node_repl 'computer').
  mcpServerKind: name => inheritedMcp.kindOf(name),
  // CU-01 stage 1: the saved choice, else 'inherit' until the decision; POST
  // /settings/computer-control changes and saves it.
  computerControlStore: bridgeSettings.computerControl,
  onComputerControlChange: computerControl => broadcast({ type: 'computer.control', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, computerControl, ts: Date.now() }),
  hostLease: hostControl.lease,
  // Decision model context setup before each ordinary turn; nothing runs while
  // the mode is 'off' (default) or no key is saved.
  decisionContext: {
    settingsGeneration: () => browserDecisionGeneration,
    mode: () => bridgeSettings.decisionContext.mode,
    configured: () => decisionCredentials.getApiKey() !== null,
    client: decisionClient,
    calibrationLog: decisionCalibrationLog,
    turnMemory: turnMemoryConfig,
    browserEntry: browserEntryConfig,
    // Advisory draft check after an answer is posted (records only). Developer flag, default off; it has no settings screen entry.
    ...(['advisory', 'on'].includes(process.env.EGDESK_DRAFT_CHECK) ? { draftCheck: { mode: () => process.env.EGDESK_DRAFT_CHECK } } : {}),
    // Live-session heartbeat (egdesk-heartbeat.mjs) and, with EGDESK_DRAFT_CHECK=on (held, checked messages), intermediate messages while a run works. Developer flag, default off.
    // attentionPosted: the session posted its pointer message for a provider's attention fact; the placement runtime withdraws it.
    // With EGDESK_PRESENCE=on the audience rule also reads the Desk's presence snapshot (egdesk-presence-mirror.mjs); without it, as before, presence is unknown.
    ...(process.env.EGDESK_CONVERSATION_FLOW === 'on' ? { conversationFlow: { mode: () => 'on', ...(process.env.EGDESK_PRESENCE === 'on' ? { presence: presenceMirror, audience: ({ run }) => runRequesters.audience({ run }) } : {}),
      attentionPosted: ({ key, provider }) => { if (provider === 'work_placement') workPlacement.acknowledgePointer(key) } } } : {}),
    // Advisory state judge on the engine's own command executions: developer flag EGDESK_COMMAND_JUDGE=advisory, default off. Records only.
    ...(process.env.EGDESK_COMMAND_JUDGE === 'advisory' ? { commandJudge: { mode: () => 'advisory' } } : {}),
    // Command gate before an engine approval card: developer flag EGDESK_TERMINAL_GATE=advisory|on, default off. It never answers an approval.
    ...(['advisory', 'on'].includes(process.env.EGDESK_TERMINAL_GATE) ? { terminalGate: { mode: () => process.env.EGDESK_TERMINAL_GATE, inspect: createGitTargetInspector(),
      // EGDESK_TERMINAL_GATE_METHOD=score selects the old 0-4 score question, only to compare; content predicates are the default.
      method: process.env.EGDESK_TERMINAL_GATE_METHOD === 'score' ? 'score' : 'predicates' } } : {}),
    // Working-memory gate at the EG-Desk tool-result boundary: developer flag EGDESK_WORKING_MEMORY=advisory|on, default off (results unchanged).
    ...(['advisory', 'on'].includes(process.env.EGDESK_WORKING_MEMORY) ? { workingMemory: { mode: () => process.env.EGDESK_WORKING_MEMORY } } : {}),
    topicRecipient: recipientForCodexDecisions,
    recipientForChatChoice: recipientForCodexDecisions,
    reviewRevision: () => handleBoardPresentationHttp.settingsRevision(),
    get memoryEvidence() { return getMemoryEvidence() },
    collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, memoryEvidenceFor, speech, clientThreadId: context.clientThreadId,
      excludeMessageId: context.localMessageId, chatStore, deskStore, ontologyStore: ensureOntologyStore })).candidates,
  },
})
// Owned Codex events reach only Chat on their originating profile, never
// the shared Reader, WebSocket, default account state, or inherited MCP sync.
codexEngine.subscribe({
  notification: (engineId, message, engineProfileId) => { void chat.handleNotification(message, engineId, engineProfileId) },
  serverRequest: (engineId, message, engineProfileId) => { void chat.handleServerRequest(message, engineId, engineProfileId) },
  connection: (engineId, state, engineProfileId) => { chat.setConnection(engineId, state.ready, { processLost: state.processLost, engineProfileId }) },
})
// Claude conversation events reach the same runtime as app-server traffic.
claudeEngine.subscribe({
  notification: (_engineId, message) => { void chat.handleNotification(message) },
  serverRequest: (_engineId, message) => { void chat.handleServerRequest(message) },
  connection: (_engineId, state) => { chat.setConnection('claude', state.ready, state.processLost ? { processLost: true } : undefined) },
})
if (chatStore) {
  try { chat.recoverInterruptedRuns() }
  catch (error) {
    chatStoreError = publicText(error?.message || 'Local chat recovery failed', 1000)
    console.error('[egdesk-codex-bridge] local chat recovery unavailable:', chatStoreError)
  }
}
// CU-07: the user's Codex MCP servers ordinary threads inherit, by name and
// status only; read once per app-server connection, then kept current by
// startup notices. Bounded QA threads disable them, so their notices are skipped.
const inheritedMcp = createInheritedMcpSync({
  request: (method, params) => appServerRequest(method, params),
  ready: () => appServerReady,
  ignoreThread: threadId => Boolean(threadId && chat.threads.get(threadId)?.executionPolicy),
  onChange: servers => broadcast({ type: 'mcp.inherited', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, inheritedMcp: servers, ts: Date.now() }),
})
const ensureChatAuth = createChatEngineAuth({ chat, refreshCodexAccount: refreshAccountState, getCodexAuth: () => authState })
// DM [보기 추천] (the person types options and asks for a recommendation) is hidden pending the owner's decision: it contradicts
// "the person just talks". Developer flag, default off: without it the capability is not listed and the route does not exist.
const CHAT_CHOICE_ENABLED = process.env.EGDESK_CHAT_CHOICE === 'on'
const handleChatHttp = createChatHttpHandler(chat, ensureChatAuth)
const handleComputerControlHttp = createComputerControlHttpHandler(chat, { port: BRIDGE_PORT })
// SUB-11: switching the Claude profile waits until no Claude turn runs (a
// running Run never moves); a new static check then re-gates the adapter.
const handleEngineProfilesHttp = createEngineProfilesHttpHandler({
  profiles: engineProfiles, port: BRIDGE_PORT, canAddAndLogin: canAddEngineProfileAndLogin,
  busy: engine => engine === 'claude' && claudeEngine.stats().activeTurns > 0,
  inUse: id => [...chat.threads].some(([cid, thread]) => thread.engineProfileId === id && chat.conversationBusy(cid)),
  refresh: async id => {
    await codexEngine.refresh(id)
    return publicEngines().find(row => row.id === 'codex') ?? null
  },
  onChange: () => {
    codexProfileServers.reconcile()
    // The new slot is unverified until its own probe returns. Retire the old
    // owner immediately, even if both slots later report the same address.
    claudeEngine.syncStatus()
    void claudeEngineStatus.refresh({ force: true }).catch(() => {})
    engineStatus.check()
  },
})
const handleHostControlHttp = createHostControlHttpHandler(hostControl, { port: BRIDGE_PORT })
// Board arrangement gets a separate guarded client over the same isolated Decisions key and budget.
const handleBoardPresentationHttp = createBoardPresentationHttpHandler({ credentials: decisionCredentials,
  getMode: () => bridgeSettings.decisionContext.mode, budget: decisionBudget, port: BRIDGE_PORT, calibrationLog: decisionCalibrationLog, fetchImpl: decisionTransport.fetch,
  // Briefing flow, `on` path. Publishing goes through the real context runtime; the design / redesign / new-component text comes from the answer's own model on a
  // private fork (egdesk-briefing-engine.mjs over codex-internal-turn.mjs). Off unless EGDESK_BRIEFING_FLOW=on here AND the chrome's egdesk.briefingFlow is "on" AND
  // the Decisions mode is on; otherwise the route answers 'no-engine' / 'mode' and does nothing. The advisory observe needs none of this.
  // Order: the Decision model decides the design guide and the subjective model fills the data (default); EGDESK_BRIEFING_ORDER=design-first keeps the earlier order for comparison.
  briefing: briefingDeps({ chat, contexts, enabled: process.env.EGDESK_BRIEFING_FLOW === 'on', order: process.env.EGDESK_BRIEFING_ORDER === 'design-first' ? 'design-first' : 'skeleton',
    // EGDESK_BRIEFING_FILL_CHECK=facts: judge only the filled pieces that carry a number, a date, a Latin word or a name (fewer tokens). Developer switch, default off (every piece).
    fillCheck: process.env.EGDESK_BRIEFING_FILL_CHECK === 'facts' ? 'facts' : 'all' }) })
// Work-surface placement (egdesk-work-placement.mjs): where an Agent's visible work surface should open, judged at the conversation's heartbeat among options the
// canvas enumerated. Off unless EGDESK_WORK_PLACEMENT=advisory or on (and the Decisions mode is advisory or on, and the chrome's egdesk.workPlacement is "advisory"); it
// records what it would choose and changes nothing on the canvas.
const workPlacement = createWorkPlacement({ client: decisionClient, mode: () => bridgeSettings.decisionContext.mode, enabled: () => ['advisory', 'on'].includes(process.env.EGDESK_WORK_PLACEMENT),
  // 'on' additionally lets a decided "point" become a pointer fact, which the session heartbeat turns into ONE chat message (EGDESK_CONVERSATION_FLOW=on). Cards are never moved in either mode.
  live: () => process.env.EGDESK_WORK_PLACEMENT === 'on', calibrationLog: decisionCalibrationLog })
// The window's event streams (/events): when the last one has been gone for 10 s, nobody can read a message, so idle live sessions end
// (a working run keeps its heartbeat). A single conversation that is closed is told by the surface: POST /chat/session/close.
const windowWatch = createWindowWatch({ onGone: () => chat.closeIdleSessions() })
const handleWorkPlacementHttp = createWorkPlacementHttpHandler({ placement: workPlacement, heartbeatFor: key => chat.heartbeatFor(key), port: BRIDGE_PORT })
// Settings → 결정 모델 · OpenAI Decisions: key status/save/remove and the mode (works signed out).
const handleDecisionHttp = createDecisionHttpHandler({ store: decisionCredentials, verifyKey: key => decisionClient.verifyKey(key),
  budget: decisionBudget, model: decisionClient.model, mode: bridgeSettings.decisionContext, port: BRIDGE_PORT, boardPresentation: handleBoardPresentationHttp,
  onSettingsChanged: () => { browserDecisionGeneration++ } })
const handleOntologyHttp = createOntologyHttpHandler({ binding: () => ontologyBinding, store: ensureOntologyStore, runtime: sqliteRuntime, port: BRIDGE_PORT })
const handleMemoryEvidenceHttp = createMemoryEvidenceHttpHandler({ port: BRIDGE_PORT,
  ensureAuth: hints => ensureChatAuth(hints, { allowIsolated: true, requireClientPair: true }),
  resolveDm: hints => chat.memoryDmAuthority(hints), captures: contextStore, getEvidence: getMemoryEvidence,
  getMode: () => bridgeSettings.decisionContext.mode })
const handleContextHttp = createContextHttpHandler(contexts, ensureChatAuth, { port: BRIDGE_PORT })
// Like /chat/history, profiles stay editable while Codex is signed out.
const handleProfileHttp = createProfileHttpHandler({ store: () => profileStore, port: BRIDGE_PORT })
// Desk and Board routes also work signed out (local data only).
const handleDeskHttp = createDeskHttpHandler({ store: () => deskStore, port: BRIDGE_PORT })
// RT-03 .egdesk export/inspect/import over the same local stores (signed out too).
// Exports go to ~/Downloads/EG-Desk, or <app data>/exports without a Downloads folder.
// RT-03 opt-in extras: captures of the signed-in account and local File drafts (off unless asked, D-R3).
const portableAttachments = createContextAttachmentProvider({ store: contextStore, ownerKey: () => publicAuthIdentityKey(authState) })
const portableFileDrafts = createManagedDraftProvider({ directory: path.join(dataDir, 'file-drafts') })
const boardAskBindingKey = randomBytes(32)
const boardAgentAsk = createBoardAgentAskService({
  desk: deskStore, profiles: profileStore, selectContext: selectBoardAgentContext, calibrationLog: decisionCalibrationLog,
  decisionStatus: () => {
    const key = decisionCredentials.getApiKey()
    const mode = bridgeSettings.decisionContext.mode
    if (!key || mode === 'off') return null
    const bindingId = createHmac('sha256', boardAskBindingKey).update(JSON.stringify([key, decisionCredentials.savedAt(), mode, decisionClient.model])).digest('hex')
    return { mode, model: decisionClient.model, client: decisionClient, bindingId }
  },
  draft: createBoardAgentDraftTransport({ readConfig: createBoardAgentDraftConfigReader({ dataDir, getDecisionApiKey: () => decisionCredentials.getApiKey() }) }),
  draftPreview: replyStyle => `${BOARD_AGENT_DRAFT_INSTRUCTIONS}\n${BOARD_AGENT_DRAFT_REPLY_STYLES[replyStyle]}`,
})
const handleBoardAgentAskHttp = createBoardAgentAskHttpHandler({ service: boardAgentAsk, port: BRIDGE_PORT })
const handlePortableHttp = createPortableHttpHandler({ desk: () => deskStore, chat: () => chatStore, profiles: () => profileStore, attachments: portableAttachments, fileDrafts: portableFileDrafts, appDataDir: dataDir, port: BRIDGE_PORT })
// Task graph (CHAT-06): /tasks/*, /task-sources; events (RT-06): /events/browser,
// /events/recent; SSE workflow.event and task.graph frames on /events.
workflow = await openWorkflowRuntime({
  dataDir, chat, port: BRIDGE_PORT, broadcast: event => broadcast(event),
  ensureAuth: () => ensureChatAuth(), getOwnerKey: () => publicAuthIdentityKey(authState), maxConcurrency: 2, localCapacity,
})
const detachContextServices = contexts.attachServices({ bus: workflow.bus, settings: bridgeSettings.contextSuggest, boards: deskStore })
for (const root of pendingFileRoots.values()) workflow.watchRoot(root)
pendingFileRoots.clear()
if (workflow.snapshot().taskError) console.error('[egdesk-codex-bridge] local task storage unavailable:', workflow.snapshot().taskError)
// ChatGPT plan usage of the signed-in identity, refreshed after sign-in and
// after each turn; a failed read leaves rateLimits as it was (null at first).
const rateLimitSync = createRateLimitSync({
  request: (method, params) => appServerRequest(method, params),
  auth: () => authState,
  ready: () => appServerReady,
  update: patch => updateAuthState(patch),
})
// SUB-14: auth/quota/permission rejections of Codex turns → authState.accessFailure.
const accessTracker = createAccountAccessTracker({ auth: () => authState, update: patch => updateAuthState(patch) })

function authSnapshot() {
  const usage = usageDisplay(authState.rateLimits, Date.now())
  // `access` tells 로그인 필요 / 인증 만료 / 한도 도달 / 권한 부족 apart (SUB-14).
  return { ...authState, usage, access: accountAccessState(authState, usage, Date.now()) }
}

function updateAuthState(patch, { broadcastStatus = true } = {}) {
  const previousAccount = modelAccountKey(authState)
  Object.assign(authState, patch, { lastRefresh: Date.now() })
  if (modelAccountKey(authState) !== previousAccount) accountAccessEpoch += 1
  if (broadcastStatus) {
    emitAuthStatus()
    broadcast({ type: 'auth-status', status: authSnapshot() })
  }
  // auth.changed carries signedIn only; the account key is compared in memory.
  workflow?.observeAuth({ signedIn: authState.isLoggedIn === true, accountKey: modelAccountKey(authState) })
  engineStatus.check()
}

function authStatusTextFor(snapshot) {
  if (snapshot.isLoggedIn) {
    return snapshot.accountEmail
      ? `Logged in as ${snapshot.accountEmail}`
      : snapshot.authMode === 'chatgpt'
        ? 'Logged in with ChatGPT'
        : 'Logged in'
  }
  if (snapshot.loginInProgress) {
    return 'Signing in…'
  }
  return snapshot.requiresOpenaiAuth ? 'Login required' : 'Ready'
}

function resetLoginState() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
  authState.loginInProgress = false
  authState.authSessionId = null
  authState.authUrl = null
  authState.verificationUrl = null
  authState.userCode = null
  authState.callbackUrl = null
  authState.loginMode = 'browser'
  authState.loginError = null
}

// Sign-in, sign-out and an account switch all change this, including a
// signed-in account without a public identity key.
function modelAccountKey(state) {
  return `${state.isLoggedIn === true}:${publicAuthIdentityKey(state) ?? ''}`
}

function appServerRequest(method, params) {
  if (!appServerReady || !rpc) return Promise.reject(chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503))
  const connection = rpc
  if (method !== 'turn/start') return connection.request(method, params)
  const epoch = accountAccessEpoch
  return accessTracker.request(method, () => connection.request(method, params),
    () => appServerReady && rpc === connection && accountAccessEpoch === epoch)
}

async function refreshAccountState({ refreshToken = false } = {}) {
  const [authResult, accountResult] = await Promise.all([
    appServerRequest('getAuthStatus', { includeToken: false, refreshToken }),
    appServerRequest('account/read', { refreshToken: false }),
  ])

  const normalized = normalizeNativeAuth(authResult, accountResult)
  const identityChanged = authState.isLoggedIn && (!normalized.isLoggedIn || publicAuthIdentityKey(authState) !== publicAuthIdentityKey(normalized))
  const previousAccount = modelAccountKey(authState)
  if (identityChanged) chat.reset()
  const nextSnapshot = {
    ...authState,
    ...normalized,
    // Usage belongs to one identity; never show the previous account's numbers.
    rateLimits: identityChanged || !normalized.isLoggedIn ? null : authState.rateLimits,
    loginInProgress: normalized.isLoggedIn ? false : authState.loginInProgress,
  }

  updateAuthState({
    ...nextSnapshot,
    statusText: authStatusTextFor(nextSnapshot),
  })
  if (authState.isLoggedIn && (identityChanged || !authState.rateLimits || usageRefreshDue(authState, usageDisplay(authState.rateLimits, Date.now()), Date.now()))) void rateLimitSync.refresh({ force: identityChanged })
  // Models belong to one account; never keep the previous account's list.
  if (modelAccountKey(authState) !== previousAccount) void modelCatalog.refresh({ clear: true })
}

function handleAppServerNotification(message) {
  accessTracker.notify(message)
  switch (message.method) {
    case 'account/updated':
      updateAuthState({
        authMode: message.params?.authMode ?? null,
        planType: publicPlanType(message.params?.planType) ?? authState.planType,
        statusText: authStatusTextFor({
          ...authState,
          authMode: message.params?.authMode ?? null,
        }),
      })
      void refreshAccountState().catch(() => {})
      return
    case 'account/login/completed': {
      // The browser login cancelled on a switch to code entry ends with its
      // own loginId; it must not end the code sign-in now running.
      if (isStaleLoginFailure(message.params, authState.authSessionId)) return
      if (loginPollTimer) {
        clearInterval(loginPollTimer)
        loginPollTimer = null
      }
      const success = message.params?.success === true
      const error = typeof message.params?.error === 'string' ? publicText(message.params.error, 2000) : null
      const nextSnapshot = {
        ...authState,
        loginInProgress: false,
        loginError: error,
        // A finished login's page link and one-time code are no longer valid.
        authSessionId: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
      }
      updateAuthState({
        ...nextSnapshot,
        statusText: success ? authStatusTextFor(nextSnapshot) : (error || 'Login did not complete'),
      }, { broadcastStatus: false })
      if (success) {
        void refreshAccountState({ refreshToken: true }).catch(() => {})
      } else {
        updateAuthState({
          statusText: error || 'Login did not complete',
        })
      }
      broadcast({
        type: 'login-finished',
        success,
        status: authSnapshot(),
      })
      emitAuthLifecycle('finished', { success, error })
      return
    }
    // Returning here is safe: onNotification still passes the message to
    // the native Reader and Chat runtime afterwards.
    case 'account/rateLimits/updated':
      rateLimitSync.notify(message)
      return
    case 'turn/completed':
      void rateLimitSync.refresh({ force: true })
      return
    case 'mcpServer/startupStatus/updated':
      inheritedMcp.notify(message)
      return
  }
}

function startLoginPolling() {
  if (loginPollTimer) clearInterval(loginPollTimer)
  loginPollTimer = setInterval(async () => {
    if (!authState.loginInProgress) {
      clearInterval(loginPollTimer)
      loginPollTimer = null
      return
    }
    try {
      const wasLoggedIn = authState.isLoggedIn
      await refreshAccountState({ refreshToken: true })
      if (!wasLoggedIn && authState.isLoggedIn) {
        resetLoginState()
        updateAuthState({
          isLoggedIn: true,
          authMode: authState.authMode,
          accountId: authState.accountId,
          accountEmail: authState.accountEmail,
          source: authState.source,
          requiresOpenaiAuth: authState.requiresOpenaiAuth,
          statusText: authStatusTextFor({ ...authState, loginInProgress: false }),
        }, { broadcastStatus: false })
        broadcast({
          type: 'login-finished',
          success: true,
          status: authSnapshot(),
        })
        emitAuthLifecycle('finished', { success: true })
      }
    } catch {
      // Keep polling; transient callback timing issues are expected.
    }
  }, 1000)
}

function scheduleAppServerReconnect() {
  if (reconnectTimer || launchConfigBlocked) return
  // 1s, 2s, 4s … up to 30s with jitter; a ready connection starts over at 1s.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    appServerBackoff.attempting()
    connectToAppServer()
  }, appServerBackoff.next())
}

function spawnAppServer() {
  if (appServerProcess && appServerProcess.exitCode == null && !appServerProcess.killed) return
  if (appServerLaunch.disableMemories) memoryIsolation = { status: 'pending', feature: 'memories' }
  const executable = resolveCodexExecutable()
  nativeCapabilities = inspectNativeCapabilities({ executable })
  const child = spawn(executable, appServerLaunch.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  appServerProcess = child
  engineStatus.check()
  child.stdout.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.log(text) })
  child.stderr.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.error(text) })
  const lost = () => {
    if (appServerProcess !== child) return
    appServerProcess = null
    appServerReady = false
    rpc?.close(new Error('Local Codex app-server exited'))
    chat.setConnection(false, { processLost: true })
    inheritedMcp.reset()
    modelCatalog.reset()
    try { appServerSocket?.close() } catch {}
    updateAuthState({ statusText: 'Codex app-server offline', loginInProgress: false })
    scheduleAppServerReconnect()
  }
  child.on('error', lost)
  child.on('close', lost)
}

async function connectToAppServer() {
  if (appServerSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(appServerSocket.readyState)) return
  try { spawnAppServer() } catch (error) {
    updateAuthState({ statusText: publicText(error.message, 1000) })
    scheduleAppServerReconnect()
    return
  }
  let socket
  try { socket = new WebSocket(APP_SERVER_WS_URL) } catch {
    scheduleAppServerReconnect()
    return
  }
  appServerSocket = socket
  const connection = new AppServerRpc({
    send: payload => socket.send(payload),
    experimentalApi: true,
    onNotification: message => {
      handleAppServerNotification(message)
      if (!nativeReader.handleNotification(message)) codexEngine.notify(message, CODEX_ENGINE_PROFILE_ID)
    },
    onRequest: message => { if (!nativeReader.handleServerRequest(message)) codexEngine.serverRequest(message, CODEX_ENGINE_PROFILE_ID) },
  })
  rpc = connection
  socket.onopen = async () => {
    try {
      await connection.initialize()
      if (appServerSocket !== socket) return
      const preflight = await preflightOwnedAppServer({
        launch: appServerLaunch, cwd: process.cwd(),
        request: (method, params) => connection.request(method, params),
        isCurrent: () => appServerSocket === socket,
        stopOwnedChild: () => {
          // Only this bridge's spawned child may be stopped; never signal a
          // user daemon or another App Server merely sharing the endpoint.
          // Fence reconnect before SIGTERM can trigger the child's exit event.
          launchConfigBlocked = true
          appServerReady = false
          if (appServerProcess && appServerProcess.exitCode == null && !appServerProcess.killed) appServerProcess.kill('SIGTERM')
        },
      })
      if (preflight.stale) return
      if (preflight.modelProof) nativePreflight = preflight.modelProof
      if (preflight.memoryProof) memoryIsolation = preflight.memoryProof
      if (!preflight.ready) {
        launchConfigBlocked = preflight.reconnectBlocked
        if (preflight.failedStage === 'model') nativePreflight = { ...nativePreflight, status: 'blocked', effectiveModel: null, effectiveEffort: null, errorCode: preflight.error.code || 'CODEX_LAUNCH_CONFIG_UNVERIFIED' }
        if (appServerLaunch.disableMemories) memoryIsolation = { status: 'blocked', feature: 'memories', errorCode: preflight.error.code || 'CODEX_MEMORY_ISOLATION_UNVERIFIED' }
        throw preflight.error
      }
      appServerReady = true
      appServerBackoff.reset()
      chat.setConnection(true)
      void inheritedMcp.refresh()
      await refreshAccountState()
      void modelCatalog.refresh()
    } catch (error) {
      console.error('[egdesk-codex-bridge] initialization failed:', publicText(error.message, 1000))
      socket.close()
    }
  }
  socket.onmessage = event => {
    if (appServerSocket === socket) connection.receive(event.data.toString())
  }
  socket.onerror = () => {
    if (appServerSocket !== socket) return
    appServerReady = false
    chat.setConnection(false)
    engineStatus.check()
  }
  socket.onclose = () => {
    connection.close()
    if (appServerSocket !== socket) return
    appServerSocket = null
    appServerReady = false
    if (!launchConfigBlocked && appServerLaunch.hasOverrides) nativePreflight = { ...nativePreflight, status: 'pending', effectiveModel: null, effectiveEffort: null }
    if (rpc === connection) rpc = null
    chat.setConnection(false)
    inheritedMcp.reset()
    modelCatalog.reset()
    engineStatus.check()
    if (appServerLaunch.disableMemories && !launchConfigBlocked) memoryIsolation = { status: 'pending', feature: 'memories' }
    scheduleAppServerReconnect()
  }
}

async function startChatgptLogin() {
  const result = await appServerRequest('account/login/start', { type: 'chatgpt' })
  if (!result || result.type !== 'chatgpt') {
    throw new Error('Unexpected login response')
  }
  updateAuthState({
    loginInProgress: true,
    authSessionId: result.loginId,
    authUrl: result.authUrl,
    verificationUrl: null,
    userCode: null,
    callbackUrl: null,
    loginMode: 'browser',
    statusText: 'Signing in…',
  }, { broadcastStatus: false })
  startLoginPolling()
  broadcast({ type: 'login-started' })
  emitAuthLifecycle('started', { loginId: result.loginId, mode: 'browser' })
  emitAuthStatus()
  broadcast({ type: 'auth-status', status: authSnapshot() })
  return result
}

// SUB-04 code entry: the screen shows verificationUrl and userCode; the user
// signs in there and types the code, so no browser callback is needed. The
// code reaches the screen only (auth status and this answer), never a log.
async function startChatgptDeviceLogin() {
  const result = await appServerRequest('account/login/start', codexLoginStartParams('device'))
  let patch
  try { patch = codexDeviceLoginPatch(result) }
  catch (error) {
    // An incomplete answer must not leave a half-started login behind.
    if (typeof result?.loginId === 'string') void appServerRequest('account/login/cancel', { loginId: result.loginId }).catch(() => {})
    throw error
  }
  updateAuthState(patch, { broadcastStatus: false })
  startLoginPolling()
  broadcast({ type: 'login-started' })
  emitAuthLifecycle('started', { loginId: patch.authSessionId, mode: 'device' })
  emitAuthStatus()
  broadcast({ type: 'auth-status', status: authSnapshot() })
  return patch
}

// ── Terminal PTY support ──
// CODE-06: a user-typed test/build command's result rides on the next /terminal/read.
const terminalRunWatch = createTerminalRunWatch({ bus: workflow?.bus ?? null, owner: WORKFLOW_OWNER })
// Terminal state judge: developer flag EGDESK_TERMINAL_JUDGE=advisory|on, default off (then this wrapper only passes calls through).
// Every Terminal card is the person's own terminal and belongs to no run: no session is agent-owned and none has an egress gate,
// so no terminal text is sent to the decision model from here; rules and process facts are recorded with zero requests.
// terminalStateWatch.terminalFacts() is the read-only, content-free fact provider for other system parts (a live-session heartbeat may also call beat()).
const terminalStateWatch = createTerminalStateWatch({ runWatch: terminalRunWatch, flag: () => process.env.EGDESK_TERMINAL_JUDGE,
  decision: { mode: () => bridgeSettings.decisionContext.mode, configured: () => decisionCredentials.getApiKey() !== null, client: decisionClient, calibrationLog: decisionCalibrationLog },
  egressFor: () => null, isAgentOwned: () => false, sendKey: (id, key) => terminalRegistry.write(id, key) })
const terminalRegistry = new TerminalSessionRegistry({ onExit: receipt => { terminalStateWatch.noteExit(receipt); workflow?.publishTerminalExit(receipt) }, runWatch: terminalStateWatch })

// npm 설치 과정에서 node-pty spawn-helper의 실행 비트가 소실되는 경우가 있어
// (posix_spawnp failed → 조용히 child_process fallback 강등) 기동 시 복구한다.
try {
  const { chmodSync, readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const prebuilds = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', 'node-pty', 'prebuilds')
  for (const dir of readdirSync(prebuilds)) {
    if (!dir.startsWith('darwin')) continue
    try { chmodSync(path.join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
} catch {}

const terminalFactory = createTerminalSessionFactory({ registry: terminalRegistry })
const handleTerminalHttp = createTerminalHttpHandler({ registry: terminalRegistry, factory: terminalFactory, port: BRIDGE_PORT })

const bridgeServer = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }

  if (!guardBridgeRequest(req, BRIDGE_PORT)) {
    sendJson(res, 403, { error: 'Loopback origin required' })
    return
  }
  setBridgeCors(req, res)
  let url
  try { url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`) } catch {
    sendJson(res, 400, { error: 'Invalid request URL' })
    return
  }
  const route = url.pathname
  // The paid closed-choice route is POST-only, including at the server's preflight boundary.
  // Flag off: the route does not exist (no later handler may serve it either).
  if (route === '/chat/choice' && !CHAT_CHOICE_ENABLED) { sendJson(res, 404, { code: 'CHAT_CHOICE_DISABLED' }); return }
  if (route === '/chat/choice' && await handleChatHttp(req, res, url)) return
  // Private management has its own POST-only contract, including preflight.
  if (route.startsWith('/memory-evidence/') && await handleMemoryEvidenceHttp(req, res, url)) return

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type, X-EGDesk-Overlay-Build, X-EGDesk-Ontology-Profile, X-EGDesk-Ontology-Token, X-EGDesk-Terminal-Owner, X-EGDesk-Terminal-View',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
    })
    res.end()
    return
  }

  // Profile-bound local ontology; no provider login or account identity needed.
  if (await handleOntologyHttp(req, res, url)) return

  // File routes have their own bounded 18 MiB draft reader and local owner.
  // Dispatch before any generic body reader or Codex/account authentication.
  if (await localFiles.handle(req, res, url)) return

  if (req.method === 'GET' && route === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let browserTransportId = null
    const client = new BoundedSseClient(res, {
      chatProtocol: url.searchParams.get('chatProtocol') === '2' ? 2 : 1,
      onClose: () => { clients.delete(client); windowWatch.left(clients.size); if (browserTransportId) browserTransport.closeClient(browserTransportId) },
    })
    clients.add(client); windowWatch.arrived()
    if (client.chatProtocol === 2) browserTransportId = browserTransport.registerClient(client)
    client.send(`retry: 1000\nevent: ready\ndata: ${JSON.stringify({ ok: true, streamId: chat.streamId, seq: chat.seq, resyncRequired: true, ...(browserTransportId ? { browserTransportId } : {}) })}\n\n`)
    return
  }

  // Workflow events and task graph routes have their own loopback/Origin guard.
  if (await workflow.handle(req, res, url)) return

  if (req.method === 'POST' && route === '/browser-tool/respond') {
    try {
      const body = await readJsonBody(req, { maxBytes: 190000 })
      sendJson(res, 200, browserTransport.receive(body.browserTransportId, body.response))
    } catch (error) {
      const failure = classifyPublicToolError(error, { browser: true })
      sendJson(res, error.httpStatus || 409, { accepted: false, code: failure.code, error: failure.message })
    }
    return
  }

  if (req.method === 'GET' && route === '/health') {
    // The unauthenticated bridge probe identifies the bound profile, not its
    // graph metadata. Full migration health requires the profile token below.
    const { profileId, ready, sqlite } = await ontologyHealth({ binding: ontologyBinding, store: ontologyStore, runtime: sqliteRuntime })
    sendJson(res, 200, { ok: true, port: BRIDGE_PORT, appServerReady, chatStorageReady: Boolean(chatStore && chat.storeHealthy), chatStorageError: chatStoreError, profileStorageReady: Boolean(profileStore), profileStorageError: profileStoreError, deskStorageReady: Boolean(deskStore), deskStorageError: deskStoreError, native: nativeCapabilities, engineConfiguration: nativePreflight, memoryIsolation, node: nodeRuntime, bridge: { buildHash: bridgeBuild.buildHash }, ontology: { profileId, ready, sqlite } })
    return
  }

  if (req.method === 'GET' && route === '/system/resources') {
    try {
      // The bridge's loopback/Origin/Fetch Metadata guard above is the local
      // caller boundary. Host metrics must work before any AI account login.
      sendJson(res, 200, await systemResourceMonitor.sample())
    } catch (error) {
      sendJson(res, 503, { code: 'RESOURCE_MONITOR_UNAVAILABLE', error: 'System resource monitor unavailable' })
    }
    return
  }

  if (req.method === 'GET' && route === '/v1/state') {
    try {
      await refreshAccountState()
    } catch {}
    // At most once a minute, in the background; a change arrives as engine.status.
    void claudeEngineStatus.refresh()
    sendJson(res, 200, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      provider: PROVIDER_ID,
      appServerReady,
      chatStorageReady: Boolean(chatStore && chat.storeHealthy),
      profileStorageReady: Boolean(profileStore),
      native: nativeCapabilities,
      engineConfiguration: nativePreflight,
      memoryIsolation,
      node: nodeRuntime,
      auth: authSnapshot(),
      chat: chat.snapshot(),
      capabilities: {
        auth: ['status', 'start', 'cancel', 'signout', 'usage', 'device-code'],
        chat: chatStore && chat.storeHealthy ? ['send', 'stream', 'resume', 'interrupt', 'approvals', 'user-input', 'subagent-status', 'typed-activity', 'artifact-refs', 'local-history', 'legacy-import', 'stateless', 'fork', ...(CHAT_CHOICE_ENABLED ? ['choice'] : []), ...(nativeCapabilities.qaReadOnly ? ['read-only-qa'] : [])] : ['local-history-unavailable'],
        context: nativeCapabilities.schemaMatch ? ['capture', 'immutable-inspect', 'native-dynamic-tools', 'smart-read', 'read-only-reader', 'answer-briefing'] : ['capture', 'immutable-inspect'],
        files: ['native-picker', 'scoped-read', 'managed-drafts', 'create-only-save-as'],
        profiles: profileStore ? ['local-store', 'revisions', 'run-binding'] : ['local-store-unavailable'],
        engines: ['registry', 'thread-lock'],
        boardDeliveryIntent: true,
        boardPresentation: true,
        channelContext: true,
        desk: deskStore ? ['local-store', 'generations', 'restore', 'board-revisions', 'board-revert', 'prefs-import'] : ['local-store-unavailable'],
        portable: [
          ...(deskStore ? ['export', 'inspect', 'import-as-new', 'passphrase', 'exports-list', 'attachments', 'file-drafts'] : ['local-store-unavailable']),
          ...(await handlePortableHttp.supportsReviewHandoff() ? ['reviewHandoff'] : []),
          ...(boardAgentAsk.available() ? ['boardAgentAsk'] : []),
        ],
      },
      bridge: bridgeBuildState(bridgeBuild, expectedOverlayBuild(req.headers, url.searchParams)),
      appServerReconnect: appServerBackoff.snapshot(),
      // Settings 'Accounts & AI engines' rows; the top-level Codex fields stay for older overlays.
      engines: publicEngines(),
      // CU-07 rows { name, enabled, status, controlsExternal, kind }, or null when unknown.
      inheritedMcp: inheritedMcp.snapshot(),
      // RT-06/CHAT-06 { tasks, taskError, maxConcurrency, eventSeq, droppedEvents, watchedRoots, maxWatchedRoots, refusedRoots, droppedFileEvents }.
      workflow: workflow.snapshot(),
      // CU-01 { policy: 'inherit'|'off', verified: true|false|null, persisted: boolean } for ordinary Codex threads.
      computerControl: chat.computerControlSnapshot(),
      // RT-07 Desk store ready; false means the screen keeps its preference values.
      deskStorageReady: Boolean(deskStore),
    })
    return
  }

  if (req.method === 'GET' && route === '/auth/status') {
    try {
      await refreshAccountState()
    } catch {}
    sendJson(res, 200, authSnapshot())
    return
  }

  if (req.method === 'POST' && route === '/auth/start') {
    try {
      // { mode: 'device' } starts code entry (SUB-04); no body keeps the browser flow.
      const body = await readJsonBody(req, { maxBytes: 1024 })
      const mode = codexLoginMode(body.mode)
      await refreshAccountState()
      if (authState.isLoggedIn) {
        sendJson(res, 200, {
          started: false,
          alreadyLoggedIn: true,
          message: authState.statusText,
        })
        return
      }
      if (authState.loginInProgress && authState.authSessionId) {
        if (authState.loginMode === mode) {
          sendJson(res, 200, codexLoginInProgressResponse(authState))
          return
        }
        // Switching between browser and code entry ends the running login first.
        try { await appServerRequest('account/login/cancel', { loginId: authState.authSessionId }) } catch {}
        resetLoginState()
      }
      if (mode === 'device') {
        const patch = await startChatgptDeviceLogin()
        sendJson(res, 200, { started: true, mode, loginId: patch.authSessionId, verificationUrl: patch.verificationUrl, userCode: patch.userCode })
        return
      }
      const result = await startChatgptLogin()
      sendJson(res, 200, {
        started: true,
        mode,
        loginId: result.loginId,
        authUrl: result.authUrl,
      })
    } catch (error) {
      const message = publicText(error instanceof Error ? error.message : String(error), 2000)
      // A malformed request (body, mode) is the caller's error, not a failed login.
      if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
        sendJson(res, error.httpStatus, { started: false, code: error.code || 'INVALID_REQUEST', message })
        return
      }
      emitAuthLifecycle('failed', { error: message })
      sendJson(res, 500, {
        started: false,
        message,
      })
    }
    return
  }

  // 'Check again' for the Claude row (e.g. after `claude auth login` in a
  // terminal): one static check, coalesced, then the public row.
  if (req.method === 'POST' && route === '/engines/claude/refresh') {
    await claudeEngineStatus.refresh({ force: true })
    sendJson(res, 200, { engine: publicEngines().find(row => row.id === 'claude') ?? null })
    return
  }

  // D-S1 login button: the line a Terminal card runs (`claude auth login
  // --claudeai|--console`). The CLI keeps the credential; EG-Desk never sees it.
  if (req.method === 'GET' && route === '/engines/claude/login-command') {
    try {
      sendJson(res, 200, claudeLoginTerminalCommand(url.searchParams.get('method') ?? undefined))
    } catch (error) {
      sendJson(res, error.httpStatus || 400, { code: error.code || 'CLAUDE_LOGIN_METHOD_INVALID', error: publicText(error.message, 300) })
    }
    return
  }

  // D-S4: an Anthropic API key in EG-Desk's environment stops Claude starts
  // until the user confirms running on the subscription without it. Names
  // only, never values; the confirmation lasts for this helper run.
  if (route === '/engines/claude/api-key-env' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: 1024 })
        if (typeof body.confirm !== 'boolean') throw chatError('INVALID_CONFIRMATION', 'confirm must be true or false', 400)
        claudeEngine.confirmApiKeyEnv(body.confirm)
      }
      sendJson(res, 200, { ...claudeEngine.apiKeyEnv(), engine: publicEngines().find(row => row.id === 'claude') ?? null })
    } catch (error) {
      sendJson(res, error.httpStatus || 400, { code: error.code || 'INVALID_REQUEST', error: publicText(error.message, 300) })
    }
    return
  }

  if (req.method === 'POST' && route === '/auth/cancel') {
    try {
      if (!authState.authSessionId) {
        sendJson(res, 200, { status: 'notFound' })
        return
      }
      const result = await appServerRequest('account/login/cancel', { loginId: authState.authSessionId })
      resetLoginState()
      updateAuthState({ statusText: 'Login cancelled' })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }

  if (req.method === 'POST' && route === '/auth/signout') {
    try {
      await appServerRequest('account/logout', undefined)
      chat.reset()
      resetLoginState()
      await refreshAccountState()
      sendJson(res, 200, authSnapshot())
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }

  if (await handleComputerControlHttp(req, res, url)) return
  if (await handleDecisionHttp(req, res, url)) return
  if (await handleBoardPresentationHttp(req, res, url)) return
  if (await handleWorkPlacementHttp(req, res, url)) return
  if (await handlePresenceMirrorHttp(req, res, url)) return
  if (await handleRunRequesterHttp(req, res, url)) return
  if (await handleEngineProfilesHttp(req, res, url)) return
  if (await handleProfileHttp(req, res, url)) return
  if (await handleDeskHttp(req, res, url)) return
  if (await handleBoardAgentAskHttp(req, res, url)) return
  if (await handlePortableHttp(req, res, url)) return
  if (await handleContextHttp(req, res, url)) return
  if (await handleChatHttp(req, res, url)) return

  // ── Terminal endpoints ──
  if (await handleTerminalHttp(req, res, url)) return

  // ── CU-01/02 host activity and control lease (local, works signed out) ──
  if (await handleHostControlHttp(req, res, url)) return
  sendJson(res, 404, { error: 'Not found' })
})

bridgeServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    // 이미 다른 브리지가 떠 있음 — 자동 기동(런처)과의 이중 실행은 정상 시나리오
    console.error(`[egdesk-codex-bridge] port ${BRIDGE_PORT} already in use — another bridge is running. Exiting.`)
    process.exit(0)
  }
  console.error('[egdesk-codex-bridge] server error:', error)
  process.exit(1)
})

bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[egdesk-codex-bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`)
  console.log(`[egdesk-codex-bridge] Node.js ${nodeRuntime.version}; requires ${nodeRuntime.minimumVersion}+, integration baseline ${nodeRuntime.integrationBaseline}; node:sqlite available`)
  broadcast({
    type: 'bridge.ready',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    ts: Date.now(),
  })
  void connectToAppServer()
  void claudeEngineStatus.refresh()
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  boardAgentAsk.close()
  acceptingFileRoots = false
  pendingFileRoots.clear()
  try { detachContextServices() }
  catch { console.error('[egdesk-codex-bridge] context services did not detach cleanly') }
  bridgeServer.close()
  localCapacity.close()
  systemResourceMonitor.close()
  try { decisionTransport.close() } catch {} // release parked and warm Decisions sockets
  try { await workflow?.close() }
  catch { console.error('[egdesk-codex-bridge] workflow runtime did not close cleanly') }
  try { await codexEngine.dispose() }
  catch { console.error('[egdesk-codex-bridge] Owned Codex conversations did not close cleanly') }
  try { await claudeEngine.dispose() }
  catch { console.error('[egdesk-codex-bridge] Claude conversations did not close cleanly') }
  try { await localFiles.close() }
  catch { console.error('[egdesk-codex-bridge] managed file store did not close cleanly') }
  try { memoryEvidenceStore?.close() } catch {}
  try { chatStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local chat store did not close cleanly') }
  try { profileStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local profile store did not close cleanly') }
  try { deskStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local Desk store did not close cleanly') }
  try { ontologyStore?.close() }
  catch { console.error('[egdesk-codex-bridge] ontology store did not close cleanly') }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  acceptingFileRoots = false
  pendingFileRoots.clear()
  try { detachContextServices() } catch {}
  localCapacity.close()
  systemResourceMonitor.close()
  workflow?.files.close()
  codexProfileServers.killAll()
  rpc?.close()
  try { appServerSocket?.close(); } catch {}
  try { appServerProcess?.kill(); } catch {}
  terminalRegistry.requestStopAll()
  terminalStateWatch.close() // also closes the run watch it wraps
})
