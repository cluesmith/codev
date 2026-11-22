#!/usr/bin/env node
// First: per-process setup that must run before anything else (#1911).
import '../dist/lib/process-bootstrap.js';

// generate-image is shorthand for codev generate-image
import { run } from '../dist/cli.js';

const args = process.argv.slice(2);
run(['generate-image', ...args]);
