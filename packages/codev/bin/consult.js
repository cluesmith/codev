#!/usr/bin/env node

// consult - AI consultation CLI (standalone command)
process.env.CODEV_STANDALONE = 'consult';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['consult', ...args]);
