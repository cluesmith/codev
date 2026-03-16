#!/usr/bin/env node

// team - Team coordination CLI (standalone command)
import { run } from '../dist/cli.js';

const args = process.argv.slice(2);
run(['team', ...args]);
