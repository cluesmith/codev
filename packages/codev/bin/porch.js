#!/usr/bin/env node

/**
 * Porch CLI - Protocol Orchestrator
 *
 * Claude calls porch as a tool; porch returns prescriptive instructions.
 */

import { cli } from '../dist/commands/porch/index.js';

// Pass args directly (skip node and script path)
cli(process.argv.slice(2));
