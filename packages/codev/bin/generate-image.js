#!/usr/bin/env node

// generate-image is shorthand for codev generate-image
import { run } from '../dist/cli.js';

const args = process.argv.slice(2);
run(['generate-image', ...args]);
