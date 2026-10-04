#!/usr/bin/env node
// Preparation only. Main owns the Firefox/bridge process lifecycle.
import { bootstrapQaProfile } from './egdesk-chat-qa-profile.mjs';

try {
  const args = process.argv.slice(2);
  let deskRecovery = null;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--desk-recovery' || !['corrupt', 'partial'].includes(args[1])) {
      throw new Error('Usage: node bootstrap-egdesk-chat-test-profile.mjs [--desk-recovery corrupt|partial]');
    }
    if (process.env.EGDESK_QA_STATE_FIXTURES !== '1') throw new Error('Recovery fixtures require EGDESK_QA_STATE_FIXTURES=1');
    deskRecovery = args[1];
  }
  const result = bootstrapQaProfile({ deskRecovery });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
