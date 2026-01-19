#!/usr/bin/env node

// porch is shorthand for codev porch (Protocol Orchestrator)
import { run } from '../dist/cli.js';

const args = process.argv.slice(2);
run(['porch', ...args]);
