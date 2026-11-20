#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

// Main codev CLI entry point
import('../dist/cli.js');
