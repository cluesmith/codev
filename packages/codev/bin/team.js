#!/usr/bin/env node

// team - Team coordination CLI (standalone command)
process.env.CODEV_STANDALONE = 'team';
const { run } = await import('../dist/cli.js');

const args = process.argv.slice(2);
run(['team', ...args]);
