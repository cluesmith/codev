#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

// team - Team coordination CLI (standalone command)
process.env.CODEV_STANDALONE = 'team';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['team', ...args]);
