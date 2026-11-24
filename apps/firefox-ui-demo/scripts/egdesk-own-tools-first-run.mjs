#!/usr/bin/env node
// Prints the first-run checklist for EG-Desk's own tools and checks preconditions (helper/egdesk-own-tools-first-run.mjs).
// It runs nothing: no process, no network, no install, no login, and it never looks inside ~/.codex.
import { firstRunChecks, formatFirstRun } from '../helper/egdesk-own-tools-first-run.mjs'
console.log(formatFirstRun(firstRunChecks()))
