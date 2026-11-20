#!/usr/bin/env node
// First: never run a program from the current folder on Windows (#1911).
import '../dist/lib/exe-search-hardening.js';

// afx - Agent Farm CLI (standalone command)
// Issue #846: imports runAgentFarm directly. The `codev afx` / `codev agent-farm`
// wrapped variants were removed because they created a `process.argv[1]` invocation-style
// split that broke spawn(execPath, [argv[1], ...]) callers (e.g. workspace-recover.ts).
import { runAgentFarm } from '../dist/agent-farm/cli.js';

runAgentFarm(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
