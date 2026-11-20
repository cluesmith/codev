#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

/**
 * Porch CLI - Protocol Orchestrator
 *
 * Claude calls porch as a tool; porch returns prescriptive instructions.
 */

import { cli } from '../dist/commands/porch/index.js';

// Pass args directly (skip node and script path)
cli(process.argv.slice(2));
