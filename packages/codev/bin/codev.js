#!/usr/bin/env node
// First: per-process setup that must run before anything else (#1911).
import '../dist/lib/process-bootstrap.js';

// Main codev CLI entry point
import('../dist/cli.js');
