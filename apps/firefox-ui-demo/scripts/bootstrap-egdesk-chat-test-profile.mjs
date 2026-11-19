#!/usr/bin/env node
// Preparation only. Main owns the Firefox/bridge process lifecycle.
import { bootstrapQaProfile } from './egdesk-chat-qa-profile.mjs';

try {
  const args = process.argv.slice(2);
  let deskRecovery = null;
  let loaderSource = process.env.EGDESK_QA_LOADER_SOURCE;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--loader-source', '--desk-recovery'].includes(name) || !value || seen.has(name)) {
      throw new Error('Usage: node bootstrap-egdesk-chat-test-profile.mjs --loader-source absolute-directory [--desk-recovery corrupt|partial]');
    }
    seen.add(name);
    if (name === '--loader-source') loaderSource = value;
    else {
      if (!['corrupt', 'partial'].includes(value)) throw new Error('Unknown recovery fixture');
      if (process.env.EGDESK_QA_STATE_FIXTURES !== '1') throw new Error('Recovery fixtures require EGDESK_QA_STATE_FIXTURES=1');
      deskRecovery = value;
    }
  }
  if (!loaderSource) throw new Error('QA requires --loader-source or EGDESK_QA_LOADER_SOURCE; personal profiles are not searched');
  const result = bootstrapQaProfile({ deskRecovery, loaderSource });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
