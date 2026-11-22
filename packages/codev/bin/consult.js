#!/usr/bin/env node
// First: per-process setup that must run before anything else (#1911).
import '../dist/lib/process-bootstrap.js';

// consult - AI consultation CLI (standalone command)
process.env.CODEV_STANDALONE = 'consult';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['consult', ...args]);
