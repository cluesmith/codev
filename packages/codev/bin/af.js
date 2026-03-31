#!/usr/bin/env node

// af - DEPRECATED: use afx instead
import { run } from '../dist/cli.js';

process.stderr.write('⚠ `af` is deprecated. Use `afx` instead.\n');
const args = process.argv.slice(2);
run(['agent-farm', ...args]);
