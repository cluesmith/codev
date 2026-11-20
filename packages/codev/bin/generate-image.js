#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

// generate-image is shorthand for codev generate-image
import { run } from '../dist/cli.js';

const args = process.argv.slice(2);
run(['generate-image', ...args]);
