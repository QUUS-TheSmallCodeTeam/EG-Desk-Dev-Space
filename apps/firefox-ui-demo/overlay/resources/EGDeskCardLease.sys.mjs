// Card operation lock (round f, L54): a single-writer UI lease per Browser Card.
// BROWSER_FRACTURE_ANALYSIS P0 #2 (one actor changes a live surface; owner, generation, start/expiry/handoff) and P0 #6 (explicit handoff).
// Pure logic, no DOM. While state is 'agent' the person's input on the card's page area is blocked; 'person' and 'handoff' never block.
// A stuck lock is worse than none, so every path ends in 'person': pause, task end, handoff, run death, bridge loss, inactivity expiry.
// Flag: pref egdesk.cardLease === 'on' (default off). No user-visible text lives here.

export const CARD_LEASE_PREF = 'egdesk.cardLease';
export const cardLeaseEnabled = (value) => value === 'on';

// Inactivity safety expiry. The Agent's tool requests on the card (observe/act) and every activity frame count as a heartbeat. The decision
// loop issues one every few seconds, a model-driven step with a slow model stays under a minute. 120 s is more than twice a slow step,
// and short enough that a dead run releases the person before they would think the card is broken.
export const CARD_LEASE_EXPIRY_MS = 120000;

export const LEASE_STATES = Object.freeze({ agent: 'agent', person: 'person', handoff: 'handoff' });

/** The idle lease: the person holds the card. generation counts agent leases taken on this card. */
export function createLease() {
  return Object.freeze({ state: 'person', owner: 'person', generation: 0, startedAt: 0, lastBeatAt: 0, tasks: Object.freeze([]), reason: 'init' });
}

const frozen = (lease) => Object.freeze({ ...lease, tasks: Object.freeze([...lease.tasks]) });
const person = (lease, state, reason) => frozen({ ...lease, state, owner: 'person', tasks: [], reason });

/** An agent task starts on the card: take the lease (or join it). Refused while the person holds a pause (hold). */
export function leaseStart(lease, taskKey, now, { hold = false } = {}) {
  if (hold || typeof taskKey !== 'string' || !taskKey) return lease;
  if (lease.state === 'agent') {
    if (lease.tasks.includes(taskKey)) return frozen({ ...lease, lastBeatAt: now });
    return frozen({ ...lease, tasks: [...lease.tasks, taskKey], lastBeatAt: now });
  }
  return frozen({ state: 'agent', owner: 'agent', generation: lease.generation + 1, startedAt: now, lastBeatAt: now, tasks: [taskKey], reason: 'start' });
}

/** A task ends (success, failure, abort). The lease returns to the person when the last task is gone.
 * reason 'human_step' (or any handoff) lands in 'handoff': same input rights as 'person', but it records that the agent asked for the person. */
export function leaseStop(lease, taskKey, { handoff = false } = {}) {
  if (lease.state !== 'agent') return lease;
  const tasks = lease.tasks.filter(key => key !== taskKey);
  if (tasks.length && !handoff) return frozen({ ...lease, tasks });
  return person(lease, handoff ? 'handoff' : 'person', handoff ? 'handoff' : 'task-end');
}

/** The agent hands a step to the person (login, password, code, payment, permission). Releases at once, whatever tasks remain. */
export function leaseHandoff(lease) {
  return lease.state === 'agent' ? person(lease, 'handoff', 'handoff') : lease;
}

/** The person pressed pause/stop (or took the card back). Always ends the agent lease. */
export function leasePause(lease) {
  return lease.state === 'agent' ? person(lease, 'person', 'pause') : lease;
}

/** The run died, the bridge disconnected, the transport was cleared, the card was revoked. */
export function leaseReset(lease, reason = 'reset') {
  return lease.state === 'agent' ? person(lease, 'person', String(reason)) : lease;
}

/** The agent did something on this card: push the inactivity expiry out. */
export function leaseBeat(lease, now) {
  return lease.state === 'agent' ? frozen({ ...lease, lastBeatAt: now }) : lease;
}

/** Inactivity expiry: release when the agent has been silent for ms. */
export function leaseExpire(lease, now, ms = CARD_LEASE_EXPIRY_MS) {
  if (lease.state !== 'agent') return lease;
  return now - lease.lastBeatAt >= ms ? person(lease, 'person', 'expired') : lease;
}

/** Ms until the lease would expire (0 when it is not an agent lease): the caller's timer delay. */
export function leaseExpiryIn(lease, now, ms = CARD_LEASE_EXPIRY_MS) {
  return lease.state === 'agent' ? Math.max(1, lease.lastBeatAt + ms - now) : 0;
}

/** The person's real input is blocked only while the agent holds the lease. */
export const leaseBlocksPerson = (lease) => lease?.state === 'agent';

/** Real (user) events only: synthetic/untrusted events and non-input events pass. */
export const LEASE_BLOCKED_EVENTS = Object.freeze(['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'wheel',
  'contextmenu', 'dragstart', 'dragenter', 'dragover', 'drop', 'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart',
  'compositionupdate', 'compositionend', 'paste', 'cut', 'touchstart']);

/** Should this DOM event be swallowed? Only trusted events (a real person, not a dispatched/internal event), only while the agent holds the lease,
 * and only for targets inside the card's page area (never the pause control, frame or other cards). */
export function leaseShouldBlock(lease, event, { inPageArea = false } = {}) {
  if (!leaseBlocksPerson(lease) || !inPageArea) return false;
  if (!event || event.isTrusted !== true) return false;
  return LEASE_BLOCKED_EVENTS.includes(event.type);
}
