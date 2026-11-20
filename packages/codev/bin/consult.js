#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

// consult - AI consultation CLI (standalone command)
process.env.CODEV_STANDALONE = 'consult';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['consult', ...args]);
