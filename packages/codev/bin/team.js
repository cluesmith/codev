#!/usr/bin/env node
// First: per-process setup that must run before anything else (#1911).
import '../dist/lib/process-bootstrap.js';

// team - Team coordination CLI (standalone command)
process.env.CODEV_STANDALONE = 'team';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['team', ...args]);
