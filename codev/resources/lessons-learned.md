# Lessons Learned

<!-- Lessons -- most important first -->

Generalizable wisdom extracted from review documents, ordered by impact. Updated during MAINTAIN protocol runs.

> **Note**: Items codified as rules (CLAUDE.md invariants, protocol requirements) are not repeated here.

---

## Critical (Prevent Major Failures)

- [From 0008] Single source of truth beats distributed state - consolidate to one implementation
- [From 0009] Check for existing work (PRs, git history) before implementing from scratch
- [From bug reports] Tests passing does NOT mean requirements are met - manually verify the actual user experience before marking complete
- [From 0043] Establish baselines BEFORE optimizing - before/after data makes impact clear
- [From 0065/PR-133] NEVER skip CMAP reviews - they catch issues manual review misses (e.g., stale commits in PR, scope creep)
- [From 0085] When guessing fails, build a minimal repro - capturing raw data beats speculation (crab icon fix took 5 failed attempts, then 1 repro solved it)
- [From scroll saga] Intermittent bugs = external state mutation. Grep for everything that touches the state before attempting fixes. The scroll issue took ~10 hours because we kept fixing the renderer instead of finding what was flipping terminal settings (one flag, one character)
- [From scroll saga] Consult external models EARLY. Three AI consultations found the root cause in minutes; solo debugging produced three failed quick fixes over hours
- [From scroll saga] Never spawn builders for symptom fixes. If you don't understand the root cause, more code won't help — PRs #220 and #225 were wasted work
- [From 0001] Trust the protocol -- both times multi-agent consultation was skipped during Spec 0001, issues were introduced that required rework. Consultation is not optional overhead; it is a safety net that catches security issues, design flaws, and protocol violations.
- [From 0009] Never merge code that has not been end-to-end tested in a browser. The custom xterm.js implementation (PR #28) passed TypeScript compilation and regex unit tests but was fundamentally broken because xterm.js v5 does not export `Terminal` as a global when loaded via `<script>` tags. "Build succeeds" is not the same as "works."
- [From 0009] When a complex approach keeps failing, step back and check what already works. The entire custom xterm.js frontend (300+ lines) was unnecessary because ttyd's default client already handles HTTP links natively. The simpler solution was zero lines of custom code.
- [From 0008] Brittleness comes from architectural fragmentation, not individual bugs. Having three implementations of the same functionality (bash, duplicate bash, TypeScript) meant bugs fixed in one remained in others. The fix was to delete duplicates and consolidate to a single canonical implementation.
- [From 0043] Replace undocumented API usage with official approaches proactively -- `CODEX_SYSTEM_MESSAGE` env var was undocumented and could break at any Codex CLI update; the official `experimental_instructions_file` config was found in GitHub discussions (#3896)
- [From 0039] When porting between languages (Python to TypeScript), well-structured original code with clear function separation makes porting straightforward -- the consult tool's ~1000 lines ported cleanly because of modular design
- [From 0045] Multi-agent consultation caught 3 critical bugs (missing backend endpoint, broken parser regex, incomplete stage linking) that would have made a feature completely non-functional. All were found during integration review before merge.
- [From 0045] Integration testing gaps slip through unit tests -- always test in the full integration environment during the Defend phase, not just with unit tests. The Builder tested feature in isolation without running the full dashboard.
- [From 0086] The drift problem is real -- Claude skips reviews when given autonomy. The Builder/Enforcer/Worker architecture exists because Porch must wrap Claude, not the other way around. Claude needs a deterministic state machine (Porch) enforcing phases, gates, and reviews to prevent it from implementing everything in one shot.
- [From 0086] `--single-phase` is essential for human interaction. Without it, the Builder has no way to monitor or relay progress. The original design had porch running to completion, but the Builder needs to stay in the loop between every phase for human visibility.
- [From 0089/0095] Spec internal consistency matters -- when the Solution section mentions a change that the Acceptance Criteria does not require, reviewers disagree about what's authoritative. Always ensure all spec sections agree on what must be delivered.
- [From 0099] Run exhaustive grep before claiming "all instances fixed." Phase 2 (naming standardization) took 4 iterations because each review round found more `af dash start` literals. After any rename or terminology change, run `rg` across the entire codebase for the old term and verify zero hits before committing.
- [From 0099] Extract testable modules upfront when wrapping singletons. When writing functions that access global state (DB singletons, caches), immediately extract the core logic into a utility with explicit parameter injection for testability. Phases 3 and 4 both required rework because initial implementations called global singletons directly.
- [From 0104] Split large files before starting feature work that touches them. `tower-server.ts` (~3,700 lines) caused the Claude consultation agent to exhaust its turn budget in 3 out of 4 Phase 3-4 reviews. A preliminary refactor would have avoided this. Consider a file size limit warning in the consult tool.
- [From 0105] Decomposition exposes hidden bugs. Phase 3 reviewers caught a startup race condition where `getInstances()` could return `[]` before `initInstances()` completed. The monolithic code hid this because everything shared one scope.
- [From 0117/0120] Porch's verdict parser cannot extract `VERDICT:` lines from Codex's raw JSONL output, defaulting to `REQUEST_CHANGES` on every iteration even when the actual review says APPROVE. This led to 12+ unnecessary consultation iterations. SDK integration eliminates this class of false positives by outputting clean text instead of JSONL.
- [From 0126] 3-way consultation caught a critical routing bug: the `/api/overview` endpoint was only registered as a global Tower route, not a workspace-scoped route -- the dashboard would have been completely broken. Before adding any Tower route, trace the full request path from dashboard fetch through workspace dispatch to global fallback.
- [From 0324] `detached: true` and `child.unref()` are necessary but not sufficient for process independence -- any pipe-based stdio (e.g., `stdio: ['ignore', 'pipe', 'pipe']`) creates a lifecycle dependency between parent and child processes. When the parent exits, the broken pipe triggers unhandled EPIPE errors in the child. Use file FDs or `'ignore'` for truly independent daemon children.
- [From bugfix-274] Startup ordering matters when multiple subsystems share resources (Shellper sockets). Initialization order creates implicit synchronization -- calling `initInstances()` before `reconcileTerminalSessions()` allowed dashboard polls to race with reconciliation. Document ordering constraints in comments.
- [From bugfix-274] Defense in depth for race conditions: the startup reorder closes the primary race path, but the `_reconciling` guard provides a safety net for code paths that bypass the primary fix (e.g., direct `/project/.../api/state` requests bypassing `getInstances()`).

## Security

- [From 0048] DOMPurify for XSS protection when rendering user-provided content
- [From 0048] External links need `target="_blank" rel="noopener noreferrer"`
- [From 0055] Context matters for escaping: JS context needs different escaping than HTML context
- [From 0052] Security model documentation is essential for any system exposing HTTP endpoints, even localhost-only
- [From 0005] Multi-agent consultation is essential for security review. Both GPT-5 and Gemini independently identified shell injection vulnerabilities (using `execAsync` with string interpolation), CORS misconfiguration (`Access-Control-Allow-Origin: *`), and input validation gaps that were missed during implementation.
- [From 0005] Prefer Node built-ins over shell commands for cross-platform safety. Using `lsof` for port detection works on macOS but fails on Windows/minimal Linux; native Node `net.createServer().listen()` is portable. Using `spawn('which', [cmd])` instead of `execAsync('command -v ${command}')` prevents shell injection.
- [From 0005] Branch name sanitization is a security requirement. Spec file names flow into git branch names; without sanitization to `[a-z0-9_-]`, malicious filenames could inject shell commands.
- [From 0022] Using `subprocess.run([...])` with list arguments (not string) bypasses shell entirely, eliminating shell injection risk. This is safer than attempting to escape arguments for shell invocation.
- [From 0020] When sending messages to Builder terminals, the Builder might be at a shell prompt rather than Claude -- the message could execute as a shell command. Document this risk and consider using structured message wrappers.
- [From 0058] XSS prevention requires consistent escaping across all rendering paths. Shared helper functions (e.g., `escapeHtml()`) reduce the chance of missing an escape point.
- [From 0061] Multi-agent consultation caught an XSS vulnerability: unescaped file paths in the 3D viewer HTML template. User-controlled data (filenames) must always be escaped before injection into HTML.
- [From 0081] When running behind a tunnel daemon (cloudflared, ngrok, Tailscale), never bypass authentication based on `remoteAddress` being localhost. Tunnel daemons run locally and proxy remote traffic, so all localhost traffic is potentially untrusted when a tunnel is active.
- [From 0081] WebSocket authentication via subprotocol header (`Sec-WebSocket-Protocol: auth-<key>`) works when the standard `Authorization` header is unavailable (browser WebSocket API limitation). Strip the auth protocol before forwarding to upstream servers.
- [From 0097] SSRF blocklist bypass via percent-encoded paths: `isBlockedPath()` must percent-decode and normalize paths (via `decodeURIComponent` + `new URL().pathname`) before checking prefixes. Prevents bypass via `%2F`, `%2f`, `%61` encoding, and `..` dot segments.
- [From 0097] `writeFileSync` with `{ mode: 0o600 }` only applies mode on file creation -- pre-existing files keep their old permissions. Always follow with `chmodSync(path, 0o600)` to enforce permissions regardless.
- [From 0099] Always use `path.sep` in path security checks. The `startsWith(projectPath)` vulnerability allows sibling directory traversal. Always use `startsWith(base + path.sep)` or `path.relative()` -- never bare `startsWith(base)`.
- [From 0099] Use collision-resistant IDs by default. Using `Date.now()` for IDs is a known anti-pattern when multiple operations can occur in the same millisecond. Use `crypto.randomUUID()` or a counter -- never timestamp-only.

## Architecture

- [From 0395] Prompt-based instructions beat programmatic file manipulation for flexible document generation — the Builder already has context and can write natural responses, while code would need fragile parsing and placeholder logic
- [From 0395] Keep specs and plans clean as forward-looking documents — append review history (consultation feedback, lessons learned) to review files, not to the documents being reviewed
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files for shared state
- [From 0039-TICK-005] Prefer CLI commands over AI agents for well-defined operations (discoverability, arg parsing, shell completion)
- [From 0039] Embedding templates in npm packages ensures offline capability and version consistency
- [From 0085] PTY sessions need full locale environment (LANG=en_US.UTF-8) — terminal multiplexers use client locale to decide Unicode vs ASCII rendering
- [From 0008] Configuration hierarchy (CLI args > config file > defaults) provides flexibility without complexity. Array-form commands in config avoid shell-escaping issues that plague string-form commands.
- [From 0008] Global state (port registry) needs file locking even for "single user" tools. Multiple concurrent CLI invocations can race on the same registry file. Use advisory locks with stale lock detection (30-second timeout).
- [From 0008] Schema versioning in state files enables future migration without breaking existing installations.
- [From 0002] Cached initialization pattern: async operations (like port registry lookup) should run once at startup via `initializePorts()`, with synchronous `getConfig()` using cached values thereafter. This avoids cascading async changes throughout the codebase.
- [From 0007] Focus management is critical for agent-driven UIs. When the architect's CLI spawns a new tab, focus must stay on the architect terminal to prevent focus-stealing while the user is typing. Manual tab creation from UI buttons should switch focus to the new tab.
- [From 0007] Tab creation should use deterministic IDs (e.g., `file-${hash(path)}`, `builder-${projectId}`) to prevent duplicate tabs when CLI and UI create the same resource simultaneously.
- [From 0020] Use tmux buffer paste (`load-buffer` + `paste-buffer`) instead of `send-keys` for injecting text into terminal sessions. `send-keys` has severe shell escaping issues with special characters; buffer paste treats content as a paste operation and avoids escaping entirely. Both GPT-5 and Gemini independently recommended this.
- [From 0014] When a CLI has multiple distinct modes (spec, task, protocol, shell), use mode-based parsing on the CLI surface but normalize to a unified internal model. This avoids duplicating infrastructure logic (git, tmux, etc.) across modes while keeping the UX clear.
- [From 0022] Replacing MCP server middleware with direct CLI delegation eliminated ~3.7k tokens of context overhead per conversation. When AI CLIs can access the filesystem directly, a middleware layer that wraps API calls adds complexity without value.
- [From 0022-TICK-001] Architect-mediated reviews (preparing context for consultants) are significantly faster than consultant self-exploration: <60s vs 200-250s per review. The architect already has the context; having each consultant rediscover it independently is wasteful.
- [From 0021] Not all AI CLIs are agentic enough to serve as Builders. Validate capabilities (tool loop, file editing, shell execution) before spawning -- non-agentic CLIs silently fail at implementation tasks rather than erroring cleanly.
- [From 0017] Multi-platform transpilation (single source of truth generating per-platform instruction files) was identified as potentially premature. Manual sync of CLAUDE.md/AGENTS.md is simpler and avoids the "lowest common denominator" problem where abstraction limits platform-specific features.
- [From 0032] Template resolution should use dynamic path finding (check compiled output path, then source path) rather than hardcoded project-relative paths -- makes code independent of directory structure
- [From 0039-TICK-002] Embedded skeleton with local overrides pattern: framework files embedded in npm package, resolved at runtime with local-first precedence. Clean for users but creates AI accessibility problems -- AI tools ignore `node_modules/`
- [From 0039-TICK-003] Copy-on-init with managed headers is better than embedded skeleton for AI-assisted development -- AI consultants need to find and read protocol files at expected local paths, not buried in node_modules
- [From 0035] MAINTAIN as a task-list protocol (vs sequential phases) works well for cross-cutting concerns that span code and documentation -- allows parallelizable independent tasks with targeted human review gates
- [From 0040] TICK as amendment (not standalone protocol) preserves single source of truth -- the spec file itself shows its evolution over time via the Amendments section
- [From 0039-TICK-005] Interactive AI sessions simplify complex merges -- rather than implementing sophisticated diff/merge logic, spawning an interactive Claude session lets the AI analyze differences contextually
- [From 0045] Keep projectlist.md as data source rather than migrating to SQLite -- markdown is git-friendly, human-editable, and LLM-context-friendly. Architecture decision validated by 3-way consultation (Gemini, Codex, Claude).
- [From 0045] Modular parser extraction (standalone TypeScript module) enables both proper unit testing and reuse. The projectlist-parser.ts module allowed 31 comprehensive tests covering edge cases.
- [From 0053] Use dedicated API endpoints for different content types (e.g., `/api/image` vs `/file`) rather than overloading a single endpoint. Keeps MIME type handling and binary serving clean.
- [From 0059] Timezone bugs are common in time-based features -- the daily summary initially used UTC instead of local time for "today" boundaries.
- [From 0062] When adding reverse proxy functionality, file-based features (like file browser tabs) may not work through the proxy without additional routing. Document known limitations explicitly.
- [From 0062] Derive port numbers from configuration, not hardcoded values. Codex caught a port derivation bug during consultation.
- [From 0068] "Tethered Satellite" hybrid architecture (cloud control plane + local execution) addresses security (code stays local), cost (heavy compute on user hardware), offline capability, and enterprise self-hosting requirements simultaneously.
- [From 0068] YAML frontmatter + Markdown status files tracked in git provide a simpler, more auditable workflow state mechanism than databases or workflow engines (Temporal, Inngest). Git provides history, blame, and portability with zero infrastructure.
- [From 0081] The EventSource API does not support custom headers. For authenticated SSE, use `fetch()` with `ReadableStream` instead.
- [From 0081] Base64URL encoding (RFC 4648) is cleaner and more compact than standard URL encoding for path segments containing slashes and special characters.
- [From 0081] When a downstream component changes its architecture (e.g., ttyd to node-pty multiplexing), upstream proxies AND related utility functions (instance discovery, stop logic) need updating. Reviewers caught that the initial TICK change only updated proxy routing but left `getInstances()` and `stopInstance()` probing dead ports.
- [From 0083] Input types and protocols are orthogonal concerns. Decoupling them (`--project` x `--use-protocol tick`) enables flexible composition without combinatorial explosion in spawn code. Protocol selection should follow a clear precedence chain: explicit flag > spec header > protocol default_for > hardcoded fallback.
- [From 0083] Protocol hooks (collision-check, comment-on-issue) should be data-driven via protocol.json rather than hardcoded in spawn functions. This makes adding new protocols possible without modifying spawn.ts.
- [From 0086] Three distinct layers (Builder/Enforcer/Worker) emerged from specific failures: Builder exists because porch was a terrible conversational interface; Enforcer exists because Claude drifts without deterministic constraints; Worker exists because `claude --print` was crippled (no tools, silent failures). Each layer addresses a concrete failure mode, not theoretical separation of concerns.
- [From 0090] Single daemon architecture simplifies operations -- no more stale state between dashboard processes. API client pattern (`af dash` calling tower API) is more maintainable than spawning separate processes.
- [From 0090] Incremental migration with test-first approach (Phase 0 baseline tests) catches regressions early when making architectural changes.
- [From 0090-TICK-001] You cannot persist a live PTY object or file descriptor to a database. Terminal session persistence means persisting metadata and reconciling against reality on startup. Destructive reconciliation (kill orphans, clear stale rows) is simpler and more reliable than attempting to re-attach to surviving processes.
- [From 0090-TICK-001] Path normalization is critical when multiple code paths (architect uses `resolvedPath`, shells use raw path) write to the same database table. Always normalize before save/delete/query.
- [From 0092] Port consolidation simplifies architecture -- moving from per-file ports (4250-4269) to Tower API endpoints eliminates 20 potential port conflicts and removes an entire server process. Single-port architecture is cleaner.
- [From 0092] In-memory file tab state (alongside terminal state in `projectTerminals`) is acceptable when tabs are lightweight to recreate. Not everything needs persistence.
- [From 0095] Transforming an orchestrator into a pure planner can be a net code deletion. Porch went from spawning Claude via Agent SDK in a while loop to just reading state and emitting JSON task definitions -- removing 1155 net lines. The key insight: let Claude Code (which already runs the Builder) be the executor, and let porch just decide what to do next.
- [From 0095] `done()` / `next()` separation prevents state corruption. Completion signaling (`porch done` runs checks, sets `build_complete`) is a different concern from planning (`porch next` reads state, emits tasks). Mixing them creates ambiguous state transitions.
- [From 0095] Filesystem-as-truth for inferring task completion (review files exist = consultation done) makes the system crash-recoverable and idempotent. No explicit "done" signal needed from the executor.
- [From 0097] HTTP/2 ServerHttp2Session cannot initiate requests from the server side. When a service is the H2 server but needs to push data to the H2 client, use a dual mechanism: in-band polling handler + out-of-band HTTPS POST.
- [From 0097] TCP proxy test pattern for reconnection testing: creating a transparent TCP proxy between client and server to simulate connection drops is effective without needing to control the remote server process.
- [From 0098] When removing infrastructure (port registry, dead modules), make database migrations no-ops rather than deleting them. This preserves migration version numbering for existing installations. Hardcoding compatibility values (e.g., `port: 0`) preserves API shape while the field is still in the interface.
- [From 0098] Project discovery after infrastructure removal: when `loadPortAllocations()` was removed, project discovery needed a new data source. Combining `terminal_sessions` table (persistent) with `projectTerminals` in-memory cache (current session) covers both sources.
- [From 0102] 3-tier resolution chain pattern (explicit arg > CWD detection > filesystem scan > error) provides good UX for CLI tools that operate in context-specific directories. Extract the resolution logic as a separate testable function with parameter injection rather than keeping it in a closure.
- [From 0103] When integrating an SDK that replaces CLI subprocess delegation, add it as a hard dependency (not optional) if it is essential for functionality. Avoids dynamic import complexity and makes dependency explicit.
- [From 0103] `CLAUDECODE` env var removal for nesting: when running Claude via SDK inside a Claude Code Builder context, iterate over `process.env` entries and exclude nesting-guard environment variables rather than using spread-and-delete (since env values can be `undefined`).
- [From 0105] TowerContext pattern for god-object decomposition: passing shared mutable state via a context object eliminates circular dependencies. Every module takes `ctx: TowerContext` as first parameter, creating clean one-way dependency flow.
- [From 0105] Extraction order matters in decomposition: start with leaf modules (types, utils) and progress to more coupled ones (routes, websocket). This minimizes merge conflicts and keeps each phase independently testable.
- [From 0105] Module boundaries should follow data flow. Tower modules follow the request lifecycle (routes -> terminals -> instances -> websocket). Spawn modules follow the concern axis (roles/prompts vs git/sessions).
- [From 0108] Fire-and-forget notification via `execFile` (no shell, callback logs errors but never throws) is the right pattern for non-critical side-channel communication from a protocol orchestrator. It is reliable, immune to shell injection, and cannot crash the caller.
- [From 0115] Using `better-sqlite3` (synchronous, already a dependency) for metrics avoids async complexity and delivers sub-millisecond writes. Good fit for best-effort telemetry that must never block the primary operation.
- [From 0118] Reusing `ShellperClient` for terminal attach (rather than raw `net.createConnection`) eliminates duplicated protocol handling -- the client already handles framing, handshake, and reconnection logic.
- [From 0118] Pre-HELLO frame gating is a necessary security measure for Unix socket servers accepting multiple clients -- unauthenticated sockets should not be able to send frames to the PTY.
- [From 0121] Rebuttal-based advancement eliminates wasted API calls from re-consultations that never change the outcome. The rebuttal file is proof the Builder engaged with feedback -- it may contain acknowledgment, changes made, or reasoned disagreement. One consultation round then advance via approval or rebuttal.
- [From 0120] When two SDK integrations follow the same pattern (Claude Agent SDK and Codex SDK), the second is straightforward to implement. Mirror existing patterns for consistency -- `runCodexConsultation()` closely mirrors `runClaudeConsultation()`.
- [From 0120] SDK config mechanisms differ between providers: Claude accepts inline `systemPrompt` string; Codex requires `experimental_instructions_file` (file path). Inspect actual TypeScript types before coding against SDK documentation.
- [From 0123] The most impactful deduplication targets are incomplete abstraction layers, not scattered magic constants. When 4 files bypass `TowerClient` with raw `fetch()` and local port constants, the constant is a symptom -- the real problem is the bypassed abstraction. Completing the abstraction (-190 net LOC) has more impact than centralizing one constant.
- [From 0123] Intentional bypasses deserve documentation, not forced consolidation. The db/ module bypasses the CLI logger because it runs in the Tower server process where chalk formatting could corrupt log files -- this is a valid reason, not technical debt.
- [From 0126] Derive status from what exists (filesystem + Tower state) rather than manually tracking it. This eliminates an entire class of drift bugs where status gets stale because nobody updated the tracking file.
- [From 0126] A single `/api/overview` endpoint that pre-aggregates builder state, PR data, and backlog is cleaner than having the dashboard make 3+ separate API calls. Different data at different cadences: `/api/state` at 1s for terminal tabs, `/api/overview` at 5s for the Work view.
- [From 0127] `execSync` in HTTP request handlers blocks the entire Node.js event loop, freezing terminal WebSocket traffic and dashboard polling. Even "cold path" calls that block for 30-60s (like `codev init`) must be async in a server with concurrent connections. `util.promisify(child_process.exec)` is a mechanical drop-in replacement.
- [From 0325] Protocol-owned prompt templates (`codev/protocols/<protocol>/consult-types/`) are better than shared templates because different protocols may want different review criteria. The resolution path (`--protocol` narrows lookup to protocol directory) is explicit and predictable.
- [From 0325] Context auto-detection (Builder vs. architect) based on cwd containing `/.builders/` eliminates a class of errors where users forget to specify which worktree to review. The `--issue` flag overrides auto-detection for architect-initiated reviews.
- [From 0399] Tower-resident scheduling beats system cron for workspace tasks: system cron lacks the user's environment (no PATH, no tokens), requires explicit sync on every config change, and keeps firing when Tower is down. Tower's scheduler inherits the full environment, auto-detects YAML changes within 60 seconds, and stops naturally when Tower stops.
- [From 0399] For condition evaluation in workspace-owned config files, `new Function('output', ...)` is acceptable since the trust level is identical to shell commands in the same YAML file. Document the tradeoff rather than over-engineering a sandbox.
- [From 0403] Idle detection (timestamp + timer) is simpler and more universal than submit-detection (Enter key parsing) for typing awareness. Enter detection has too many edge cases: Enter in vim/nano means newline, multi-line paste contains `\r`, and you need timeout fallbacks anyway. The simpler approach works with any terminal application.
- [From 0403] Per-session message buffering with configurable idle threshold (3s) and max buffer age (60s) prevents message injection during typing while ensuring delivery within bounded time. The `interrupt` option provides an escape hatch for urgent messages.
- [From 0386] Three-tier documentation audit structure (public-facing, developer reference, skeleton templates) with a "historical release notes are read-only" carve-out prevents over-zealous cleanup of historically accurate content.
- [From 0376] Archive `status.yaml` files before `af cleanup` -- most projects' porch state files are deleted after PR merge, losing valuable timing data for future development analyses.

## Process

- [From 0044] Phased approach makes progress visible and commit messages meaningful
- [From 0054] Keep specs technology-agnostic when implementation should match existing codebase patterns
- [From 0059] Verify what data is actually available in state before designing features that depend on it
- [From 0057] Always handle both new and existing branches when creating worktrees
- [From 0001] XDG sandboxing should be implemented from Phase 1, not deferred to Phase 6. Tests that touch `$HOME/.config` directories risk damaging user configuration. Setting `XDG_CONFIG_HOME` to a test-specific temporary directory is the standard solution.
- [From 0001] Group tests by scenario (what is being tested) rather than by technical implementation detail. This makes it easier to run subsets and understand test purpose at a glance.
- [From 0001] Create failing shims instead of removing tools from PATH when mocking command absence. A shim that exits non-zero is more realistic than PATH manipulation and prevents accidentally finding other system commands.
- [From 0006] Keep tutorial steps focused and short. Long steps lose user attention. Creating real files during the tutorial provides tangible output that users appreciate.
- [From 0002-TICK-001] Shell escaping in tmux is treacherous. Complex content (role files with backticks, $variables, special characters) cannot be passed directly to `tmux new-session` commands. The solution is to create a launch script file that tmux executes.
- [From 0012] When duplicating changes across mirrored source trees (e.g., `packages/codev/src` and `agent-farm/src`), the sync should be automated (symlinks or build step) rather than manual to prevent drift.
- [From 0019] Read the protocol documentation BEFORE starting implementation, not mid-way through. The TICK protocol was unfamiliar to the Builder, causing incorrect commit ordering that had to be corrected after the fact.
- [From 0022-TICK-001] The TICK-as-amendment workflow (per Spec 0040) provides a natural extension mechanism for existing specs. Clean separation of amendment logic (`do_pr_mediated()`) from original code keeps both code paths maintainable.
- [From 0028] When considering new abstractions (roles, agents, protocols), ask whether the responsibility is ongoing (role) or episodic (protocol). Documentation maintenance looked like a role (Librarian) but was better served as a protocol (MAINTAIN), keeping the role model simple.
- [From 0015] Soft-delete with auto-generated restore scripts is safer than permanent deletion for codebase cleanup. Preserving original directory structure in the trash directory makes restoration trivial.
- [From 0038] CLI hybrid patterns are tricky -- when you need both positional-first commands (`consult MODEL QUERY`) and subcommands (`consult pr NUMBER`), manual argument parsing may be cleaner than fighting framework limitations (Typer couldn't handle it)
- [From 0039-TICK-001] Consolidate implementations early to prevent drift -- maintaining Python and TypeScript versions of consult in parallel led to improvements in one not reaching the other (Spec 0043's Codex optimizations only updated Python)
- [From 0039-TICK-002] Document supersession clearly in TICK amendments -- mark which original sections the amendment replaces to avoid confusion between historical and current content
- [From 0045] Expect UI iteration post-merge -- spec wireframes are a starting point, not the final design. Real usage reveals better patterns. The Projects tab went through 2 significant redesigns after merge.
- [From 0045] Document custom parser grammars explicitly -- if avoiding external dependencies (no js-yaml), create an explicit schema of the YAML subset supported to prevent regex brittleness.
- [From 0046] Documentation structure works well as overview + individual command files. Always copy framework docs to skeleton for distribution. Make docs discoverable by AI agents via CLAUDE.md/AGENTS.md references.
- [From 0051] Comparison tables (Traditional vs Codev) effectively communicate paradigm shifts in onboarding material. ASCII art diagrams work well for showing conceptual relationships in markdown.
- [From 0054] When specs reference external source files (e.g., Python implementation to port), verify the file is accessible from the Builder worktree before starting implementation.
- [From 0087] Mirror existing patterns when adding reliability features. Porch's build timeout/retry mirrors the existing consultation system's pattern (3 retries, exponential backoff, configurable timeout), reducing cognitive load and leveraging proven logic.
- [From 0094] For purely visual changes, a before/after screenshot comparison in the PR is more valuable than test results.
- [From 0094] Specs with exact CSS snippets make implementation straightforward -- precise specifications eliminate ambiguity for Builders.
- [From 0095] Extract shared functions before deleting the file that contains them. Moving `parseVerdict()` to `verdict.ts` in Phase 1 (rather than waiting for Phase 2's deletion of `run.ts`) simplified the refactoring sequence.
- [From 0096] Monorepo porch compatibility: `porch done` runs `npm run build` and `npm test` from the worktree root, but there may be no root `package.json`. The fix is adding `"cwd": "packages/codev"` to the protocol checks.
- [From 0097/0113] Set iteration limits for 2/3 approval: when 2 of 3 reviewers consistently approve, the third reviewer's recurring concerns should be evaluated against a threshold to prevent infinite iteration loops. A single reviewer repeating the same concern should not block progress indefinitely. Consider auto-advancing when 2/3 approve for 3+ consecutive iterations with documented dissent.
- [From 0098] Combine infrastructure removal and test updates in the same plan phase. Splitting them creates unnecessary overhead -- test fixes are needed to make the removal compile, so they should be together.
- [From 0098] Include template files (HTML with inline JavaScript) in the plan's file list when planning TypeScript-focused changes. A grep for removed identifiers across all file types (not just `.ts`) during planning catches hidden dependencies.
- [From 0101] Place test files matching project conventions from the start. Using wrong paths in the plan (e.g., `tests/unit/` when the project uses `src/__tests__/`) causes repeated false negatives from consultation reviewers searching at planned-but-nonexistent paths.
- [From 0101] Skip screenshot baselines in implementation plans. Playwright `toHaveScreenshot()` generates baselines on first run. Requiring pre-committed baselines causes reviewers to block every iteration looking for PNG files that do not exist pre-first-run.
- [From 0102] Run `porch done` immediately after implementation, before ending a session. Resumed sessions can have state mismatches if the previous session implemented code but never advanced porch state.
- [From 0104] Tighter iteration caps per phase: after 3 iterations with the same reviewer pattern (e.g., Codex REQUEST_CHANGES on the same cosmetic issue), a manual architect override saves time. SPIR should recommend a maximum iteration count (e.g., 4) per plan phase.
- [From 0104] Start with comprehensive context files for consultation agents. Sparse initial context files lead to false-positive reviews that require rebuttals and re-consultation cycles.
- [From 0106] Pre-check for merge artifacts before starting implementation. Run `git diff main -- <files>` to identify unexpected changes from merge resolution that may need to be addressed alongside the feature work.
- [From 0107] Extracting shared infrastructure first (Phase 1 of a multi-phase plan) makes subsequent phases cleaner and independently testable.
- [From 0107] Research framework API behavior (e.g., Commander.js alias visibility) before writing plans that depend on assumed behavior.
- [From 0107] Plans should explicitly state which existing UI patterns to follow for new UI elements, avoiding back-and-forth on implementation details (e.g., `<dialog>` vs `<div>` overlay).
- [From 0108] Distinguish similarly-named modules in specs and plans. `gate-status.ts` (passive reader, still used by dashboard) vs `gate-watcher.ts` (active poller, dead code) caused confusion because the names are too similar without explicit role descriptions.
- [From 0110] Start integration tests early -- when the endpoint is built (Phase 2), not at the end (Phase 4). The integration test gap was not caught until Phase 4 iteration 2.
- [From 0110] Write explicit rebuttal documentation upfront for recurring reviewer concerns. Saves time across consultation iterations when a reviewer repeats the same point.
- [From 0110] Centralized routing (moving address resolution from CLI to server) is a significant simplification. `send.ts` dropped from 327 to 219 lines by delegating all resolution to Tower.
- [From 0112] The TypeScript compiler-guided approach for large-scale renames is highly effective: rename types/interfaces first, then let compile errors cascade through downstream files. No manual tracking needed beyond initial type changes.
- [From 0112] SQL string literals are invisible to the TypeScript compiler. After any rename involving database columns, grep verification is essential.
- [From 0112] For large-scale renames, run targeted test slices per phase (only tests touching modified files) rather than the full suite each time. Faster and less noisy.
- [From 0113] Not every code path needs a dedicated test. Safety nets (like a 3-line setTimeout fallback) can be validated by code review when test infrastructure cost is disproportionate.
- [From 0115] Spec-level JSON/JSONL output format examples are invaluable for writing extraction tests without needing live model access.
- [From 0115] Having cost formulas explicitly stated in specs prevents ambiguity about cached token pricing.
- [From 0111] For simple deletion tasks, separate "verify" phases can be merged with the deletion phase since verification is just running build/test commands.
- [From 0112] SPIR consultation overhead is high for mechanical refactoring. For future large-scale renames, lighter-touch review (spot-check + automated verification) may be more efficient than full 3-way consultations per phase.
- [From 0121] When a safety valve becomes unreachable due to a design change, remove it rather than keeping it as dead code. The rebuttal mechanism made the max_iterations safety valve unreachable -- removing it is cleaner than leaving code that can never execute.
- [From 0121] Update spec and plan simultaneously rather than in separate passes. Multiple rounds of corrections were needed for stale references to old values (max_iterations=5, >50 bytes size checks) that had been changed in one document but not the other.
- [From 0122] When a spec is filed for functionality that already exists (built incrementally across prior specs/bugfixes), the plan should note this upfront. Discovery during implementation wastes time -- the plan should focus on validation and enhancement.
- [From 0124] Plan estimates based on file-level scanning can misattribute tests. Phase 3's tunnel estimate was wrong because the plan listed tests by file without verifying which describe blocks were in which file. Include a preliminary audit step where files are actually read before estimating removals.
- [From 0124] Set removal/consolidation targets as ranges rather than point estimates. The spec targeted ~285 tests but achieved 127 -- the aspirational target was unrealistic after applying the "when in doubt, keep the test" guardrail.
- [From 0126] Six-phase bottom-up plan (GitHub layer -> spawn CLI -> scaffold -> tower endpoint -> work view -> cleanup) with clear dependency ordering meant each phase built cleanly on the previous. Test-first approach for spawn CLI caught edge cases in zero-padded ID handling.
- [From 0126] Update skeleton docs when changing user-facing behavior. Initially rebutted as out-of-scope, but shipping skeleton docs with stale references confuses users of new projects.
- [From 0127] For mechanical refactors (sync -> async, rename, move), a single-phase plan is sufficient. Two-phase splits driven by minimum porch requirements rather than natural work boundaries add overhead without value.
- [From 0350] Verify the test runner configuration before writing tests. Dashboard tests use a separate vitest config (`dashboard/vitest.config.ts`) and are excluded from the main test runner -- discovering this mid-development wastes time.
- [From 0376] Documentation-only specs need a lighter porch path -- full SPIR with 3-way impl consultation doesn't add value when there's no code to review. `consult --type impl` requires a PR diff, producing "No PR found" for documentation projects.
- [From 0376] Pre-check `consult` compatibility for documentation-only specs -- the plan should explicitly note that impl-review will produce "No PR found" and plan for manual APPROVE files.
- [From 0386] Always audit both `codev/` and `codev-skeleton/` locations for any documentation pattern -- the dual-directory structure (our instance vs. distribution template) is a known footgun where fixes to one location miss the other. All three CMAP reviewers caught this gap.
- [From 0386] Run the final stale-reference sweep BEFORE the verification phase, not as part of it -- catches cross-tier issues earlier when context is fresher.
- [From 0386] Include SPIDER-to-SPIR in stale pattern lists when doing documentation audits -- protocol renames are easy to miss.
- [From 0364] Porch and consult should agree on file naming conventions -- porch expects `364-*.md` but consult looks for `0364-*.md`. Symlinks work as a workaround but the inconsistency is a recurring friction point.

## Testing

- [From 0009] Verify dependencies actually export what you expect before using them
- [From 0041] Tarball-based E2E testing catches packaging issues that unit tests miss
- [From 0039-TICK-005] Regex character classes need careful design - consider all valid characters in user input
- [From 0059] Timezone handling: use local date formatting, not UTC, when displaying to users
- [From 0001] Prefer behavior testing over implementation testing to avoid overmocking. Test file system outcomes rather than individual shell commands. Control tests (verifying default behavior) should precede override tests.
- [From 0001] Use portable shell constructs to avoid BSD vs GNU differences. Cross-platform issues to watch for: `find` syntax, `stat` command flags, `timeout` vs `gtimeout` availability. Platform detection with conditional logic is the standard workaround.
- [From 0001/0096] XDG sandboxing for CLI tests: set `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` to temp directories to isolate tests from the user's real config, preventing pollution in both directions. Implement from Phase 1, not as an afterthought.
- [From 0006] readline-based interactive prompts are difficult to unit test. Consider this when designing CLI tools and plan for integration testing or manual testing as the primary validation strategy.
- [From 0031] For concurrency testing of SQLite operations, use `worker_threads` or `child_process` to spawn truly parallel operations rather than relying on async scheduling within a single process.
- [From 0031] When migrating from JSON to SQLite, keep `.json.bak` files permanently for rollback capability. Transaction-wrapped migration ensures atomicity -- partial migrations are impossible.
- [From 0041] npm install per test is slow but necessary for isolation -- shared installations risk test interference
- [From 0041] Sync CLI version with package.json at build time -- hardcoded versions in CLI code drift from package.json, forcing tests to be version-agnostic
- [From 0043] `model_reasoning_effort=low` for Codex consultations achieves 27% time reduction and 25% token reduction while maintaining or improving review quality -- the optimized Codex found a valid issue the baseline review missed
- [From 0034] Multi-agent consultation at end of TICK caught a critical indentation bug in table alignment -- the `renderTableRow` function was stripping leading whitespace, breaking nested tables
- [From 0045] Parser regex needs to account for YAML list syntax (`- id:` vs `id:`) -- initial regex `/^\s*(\w+):\s*(.*)$/` failed on leading dashes. Fixed to `/^\s*-?\s*(\w+):\s*(.*)$/`.
- [From 0053] Query parameter handling matters for endpoint matching -- initial `/api/image` exact-match check failed because the client uses `?t=...` for cache-busting. Use `startsWith()` or proper URL parsing.
- [From 0053] Clean up stale node processes from previous tests before running new tests. Lingering processes cause confusing failures.
- [From 0056] Path fallback patterns need explicit testing -- mock both paths (new location exists, old location exists, neither exists) to catch regressions. Always run `copy-skeleton` after modifying `codev-skeleton/` to ensure changes propagate.
- [From 0058] Debouncing is essential for search inputs to prevent excessive DOM updates. A global Escape key handler adds resilience by ensuring modals/overlays can always be dismissed.
- [From 0076] Test bugfixes with the actual user workflow before marking complete. The original Bugfix #132 was merged but never manually tested -- it checked the wrong process (ttyd PID instead of tmux session).
- [From 0076] When bugfixes involve process management, document the full process chain. The shell -> tmux -> ttyd lifecycle was not documented, leading to incorrect assumptions about which process to check.
- [From 0078] Policy violations matter even in example code. Codex caught `git add .` in pseudocode in the plan. Maintain consistent standards across all artifacts.
- [From 0078] Test all signal types, not just the happy path. All three reviewers independently caught missing AWAITING_INPUT and BLOCKED signal tests.
- [From 0078] For test-mode switches, environment variables (`PORCH_AUTO_APPROVE`) are often more flexible than CLI flags because they can be set in test harnesses without modifying CLI invocations.
- [From 0078] Interactive CLI testing requires careful stdin/stdout management. Encapsulate complexity in a helper (e.g., `runPorchInteractive()`) that accepts pre-configured responses and records signals.
- [From 0086] E2E tests with real API calls are expensive and slow (~$4, 10-40 minutes per run). Mock tests are essential for fast feedback. Real E2E should be reserved for integration validation, not routine development.
- [From 0086] Agent SDK message types matter -- the SDK emits `assistant`, `result`, `tool_progress`, `tool_use_summary`, `stream_event`, not `tool_result`. Check actual TypeScript type definitions rather than guessing API structures.
- [From 0087] Output file numbering per retry attempt (`-try-{m}`) ensures no debug data is lost during retries. Preserve partially-written artifacts from failed builds for debugging.
- [From 0096] Separate vitest configs for different test suites are valuable. The `*.e2e.test.ts` naming convention requires separate configs because the default config explicitly excludes them. Different timeouts (30s for CLI tests vs 20min for porch e2e) keep test runs fast.
- [From 0096] Always run the actual coverage tool to get a baseline before setting thresholds. Assumptions about coverage levels are often wrong -- the spec assumed 70% lines would be conservative, but actual baseline was 62.31%.
- [From 0096] CLI integration tests should run `node dist/codev.js` (built artifact) rather than importing source directly. This tests the real CLI entry point. Tarball packaging integrity is separately verified by `verify-install.mjs`.
- [From 0097] MockTunnelServer pattern: creating a mock server in early phases proves invaluable for fast, deterministic testing throughout later phases without external dependencies.
- [From 0103] Research SDK APIs before writing specs and plans. The spec assumed several options (`persistSession`, `effort`, `tool_use_summary`) that do not exist in the Claude Agent SDK. Early research during planning prevents implementation rework.
- [From 0105] `return await` is critical in handler wrappers: when a function delegates to another async function inside try/catch, `return await fn()` is required, not `return fn()`. Without `await`, errors bypass the catch block.
- [From 0105] `fatal()` mock behavior differs from production: in production, `fatal()` calls `process.exit()` (not catchable). The mock throws an Error (catchable by try/catch). Tests for try/catch-wrapped code must assert `fatal` was called rather than using `rejects.toThrow`.
- [From 0109] Export test-relevant constants (like heartbeat intervals) from the module under test from the start, rather than noting it as a later-phase detail.
- [From 0109] Write reusable mock helpers (e.g., mock WebSocket) if more tests of the same subsystem are anticipated.
- [From 0110] For integration tests, prefer explicit resource registration (e.g., `POST /api/terminals`) over `activateWorkspace` which waits for auto-spawned terminals -- the former is faster and more deterministic.
- [From 0116] Shared E2E test utilities (extracting `startTower`/`stopServer`/port helpers into `tower-test-utils.ts`) eliminate duplication and ensure consistent setup/teardown patterns.
- [From 0116] Use `extraEnv` parameters on test helper functions rather than mutating `process.env` -- cleaner isolation between tests.
- [From 0116] Port collisions in parallel E2E tests (e.g., multiple suites hardcoding port 14500) cause flaky failures when vitest runs them sequentially in the same process. Assign unique ports per suite.
- [From 0124] Complementary test layers look like overlap from the outside. `tower-instances.test.ts` and `tower-routes.test.ts` seemed duplicative until the audit showed they test different layers (service vs HTTP dispatch). Always audit actual file contents before removing "duplicates."
- [From 0124] Type-check tests have zero value in TypeScript. Tests that only assign values to typed variables and assert the assignment are testing the compiler, not the code.
- [From 0124] "When in doubt, keep the test" is the right default for consolidation. It is better to remove fewer tests with confidence than to hit a numeric target by removing borderline tests.
- [From 0122] Reconciliation logic may skip temp/test paths (like /tmp and /var/folders). E2E tests for reconnection need workspace paths outside excluded directories (e.g., under `~/.agent-farm/test-workspaces/`).
- [From 0324] Node.js async EPIPE is dangerous for daemon processes -- when a writable stream connects to a broken pipe, Node.js delivers EPIPE as an unhandled `'error'` event. Always add `stream.on('error', () => {})` handlers on process stdio streams for long-lived detached processes.

## UI/UX

- [From 0050] Differentiate "not found" vs "empty" states to prevent infinite reload loops
- [From 0050] State-change hooks should run after every state update, not just on init
- [From 0055] Be selective about file exclusions - exclude heavyweight directories, not all dotfiles
- [From 0057] Follow git's branch naming rules - use pattern-based rejection, not whitelist
- [From 0002-TICK-001] Shell escaping in terminal multiplexers: complex content with backticks/quotes needs launch scripts
- [From 0085] xterm.js `customGlyphs: true` renders block elements procedurally — crisp at any size, no font dependency
- [From scroll saga/0012] Always use session-scoped terminal multiplexer settings, never global flags. Global tmux flags can poison ALL sessions on the machine. Use per-session configuration (`tmux set-option -t <session>`) to avoid polluting the user's global tmux environment.
- [From 0009] BroadcastChannel provides clean cross-tab communication for same-origin pages, working around cross-origin iframe restrictions that block direct postMessage.
- [From 0009] Server readiness matters for iframe loading. When creating tabs that load iframe content from newly spawned servers, poll for port readiness before returning success. A 5-second timeout with `waitForPortReady()` prevents the common "blank iframe, refresh to fix" issue.
- [From 0011] HTML-escape all user-derived content injected into templates (project names, file paths) to prevent XSS.
- [From 0019] Don't rely solely on color for status indicators -- add shape differences (diamond for blocked), pulse animations, and tooltips for accessibility. `prefers-reduced-motion` media query should be included for animation-heavy UIs.
- [From 0019] `role="status"` on elements that update every polling cycle causes screen reader chatter. Use `role="img"` with descriptive `aria-label` instead for status dots.
- [From 0029] Web browsers don't provide native directory pickers that return server-accessible absolute paths. For server-side path input, use a text input field rather than attempting `<input webkitdirectory>`.
- [From 0037] Tab overflow detection needs both initial check and resize handler -- use `scrollWidth > clientWidth` comparison with debounced resize handler; also update count on tab add/remove
- [From 0034] Table detection using header+separator pattern (header line with pipes, followed by separator row with dashes) avoids false positives on prose containing pipe characters
- [From 0045] Security-first approach for user content rendering: XSS protection and path validation should be built in from the start, never as a "TODO" or afterthought.
- [From 0050] Click event propagation: when moving click handlers from parent to child elements, use `event.stopPropagation()` to prevent events from bubbling to the parent.
- [From 0050] UX consistency: if you remove click behavior from an element, also remove visual indicators (cursor, hover effect). Users expect pointer + hover = clickable.
- [From 0048] Conditional CDN loading (via `document.write` inside `if` blocks) cleanly avoids loading libraries for file types that don't need them. Percentage-based scroll preservation is "good enough" -- perfect scroll mapping is unnecessary.
- [From 0094] Semantic CSS classes (`.new-shell-row`) are more robust than targeting inline styles via CSS attribute selectors (`[style*="border-top"]`).
- [From 0099] Differentiate error types in CLI commands. CLI commands that call APIs must distinguish connection-level failures (server not running) from application-level errors (server returned an error) and show different user-facing messages.
- [From 0126] Building the overview endpoint to work in degraded mode (showing builders but empty PR/backlog sections with error messages when `gh` is unavailable) is a good default pattern for features that depend on external services.
- [From 0364] Use `onPointerDown` with `preventDefault()` and `tabIndex={-1}` to prevent focus stealing from terminal widgets -- this pattern translates directly to any floating controls rendered alongside interactive widgets.

## Documentation

- [From 0044] Documentation synchronization burden (multiple identical files) is error-prone - consider single source
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)
- [From 0044] Review types as separate markdown files (not inline strings) improves maintainability and allows user customization -- five files in `codev/roles/review-types/` each following consistent structure
- [From 0044] Appending type-specific prompts to base consultant role preserves personality while adding specialized focus -- better than replacing the role entirely
- [From 0052] ASCII diagrams work well for terminal-based documentation and render consistently in markdown viewers.
- [From 0052] Including actual SQLite schema SQL in documentation helps readers understand data models without reading code.
- [From 0052] Error handling and recovery mechanisms deserve their own documentation section -- real-world operation involves failures, and documenting recovery helps operators troubleshoot.
- [From 0126] When removing a tracking file (projectlist.md), let it become a dead file rather than deleting it or migrating data. No code reads it, no command deletes it. Over time users can archive or delete manually. This avoids a migration step and preserves git history.
- [From 0386] Documentation audit should be formalized as a MAINTAIN protocol task -- the stale reference patterns list and tier structure can become a quarterly checklist.
- [From 0386/0399/0403] Consult CLI needs better multi-project support -- the "Multiple projects found" error in Builder worktrees is a recurring issue. Worktrees inherit project directories from main, causing `consult` to fail. The `--prompt-file` workaround bypasses project detection but loses structured context. The CLI should support `--project-id` to disambiguate.
- [From 0376] The research agent pattern (spawning a subagent to read all review files in parallel and return structured data) should be documented as a standard approach for future analyses.

## 3-Way Reviews

- [From 0054] Each reviewer catches different aspects - Claude: spec compliance, Gemini: API correctness, Codex: practical issues
- [From 0061-002] Security vulnerabilities (XSS) often identified in 3-way review that weren't in initial implementation
- [From CMAP analysis] CMAP misses proxy/deployment topology bugs and React lifecycle/WebSocket timing issues — add "works behind reverse proxy?" to review checklist for HTTP specs
- [From CMAP analysis] When 2/3 approve for 3+ consecutive rounds, auto-advance with documented dissent — prevents 7-10 iteration loops
- [From 0001] Multi-agent consultation must include FINAL approval on the FIXED version, not just the initial review. Presenting fixes directly to the user without re-consulting creates a gap where new issues can be introduced.
- [From 0005] Different models catch different categories of issues: GPT-5 found shell injection and input validation gaps; Gemini found race conditions and CORS misconfiguration. Using both provides broader coverage than either alone.
- [From 0012] For small, well-defined changes (like adding a single tmux option at 6 locations), end-only consultation is sufficient. Both reviewers approved without changes, confirming that the task scope matches the consultation effort.
- [From 0009] End-only consultation caught critical issues (hardcoded ports, Builder path resolution, double API calls) that would have been missed without review. Even for seemingly simple TICK implementations, consultation provides value.
- [From 0019] Multi-agent consultation at the review phase caught important accessibility issues (role="status" misuse, missing prefers-reduced-motion) that would have been missed in solo implementation. End-only consultation is effective for small UI changes.
- [From 0022-TICK-001] When adding new modes to existing code, always ensure new code paths include cleanup logic. The mediated PR review mode initially missed adding `cleanup_old_pr_consultations()` -- caught during 3-way review.
- [From 0029] Review feedback identified underspecified launch mechanisms and process lifecycle management that the spec author hadn't considered: detached process behavior, log routing, and directory validation.
- [From 0038] Verdict parsing needs robustness -- models don't always follow the exact format requested; fallback to "last 50 lines" handles this gracefully
- [From 0038] Pre-fetching PR data (6 commands upfront) significantly reduces redundant operations compared to letting each model agent fetch its own data (from 19+ git commands to 6)
- [From 0043] Codex `model_reasoning_effort=low` produced a more focused review that caught an issue the default-effort review missed -- lower reasoning effort may reduce meandering exploration
- [From 0045] Consultation value is highest on integration reviews -- the 3-way review on PR #85 caught bugs that unit tests couldn't (missing endpoint, broken regex on real data, incomplete linking).
- [From 0048] Plan-level 3-way reviews catch architectural misunderstandings early -- Codex identified that the plan initially wired preview to the wrong UI container (#editor instead of #viewMode), which would have caused a fundamental implementation error.
- [From 0054] When porting between languages/ecosystems, always check the actual package structure. The plan mentioned Python/Typer but the correct approach was TypeScript/Commander since codev is a Node.js package.
- [From 0053] Spec interpretation diverges across reviewers -- "same annotation system available" was read literally by one reviewer (needing image annotation) but correctly scoped by another (noting line-based annotation is technically infeasible for images without a new coordinate-based system).
- [From 0089] When a spec is internally inconsistent (Solution section says one thing, Acceptance Criteria says another), reviewers will disagree about which section is authoritative. Acceptance Criteria should always be the definitive source.
- [From 0095] Codex caught state mutation path ambiguity (when does `porch next` modify state vs just emit tasks?) that the other reviewers missed. State mutation rules need explicit documentation for any command that reads and writes state.
- [From 0107] 3-way consultation caught real bugs: stuck button state, nonce placement, body.name truthiness check. The rebuttal mechanism effectively handles false positives.
- [From 0108] Gemini's plan review caught that `gate-status.ts` is used by the dashboard API, preventing a build-breaking deletion. Codex refined notification semantics (transitions vs re-requests).
- [From 0113] Multi-agent consultation caught a real bug: `stderrClosed` as a local boolean was copied by value into the session object, so the close callback never updated the session.
- [From 0118] Codex reviewer consistently found edge cases (pre-HELLO gating, workspace scoping) that improved the design, despite high iteration counts.
- [From 0124] Reviewers hallucinate coverage loss. Always verify reviewer claims against actual code before acting on them.
- [From 0124] Reviewers may recommend removing tests that serve a different purpose than they appear. Codex said REST API tests "aren't PTY-specific" but they test `TerminalManager.handleRequest`, which is unique to that class.
- [From 0126] Workspace-scoped routing is a common blind spot in consultation. The Tower server has global and workspace-scoped routing layers; Claude caught that `/api/overview` was only registered globally, which would have broken the dashboard.
- [From bugfix-274] Codex caught a secondary race path through the Tower API that the initial fix missed -- the direct `/project/.../api/state` endpoint bypasses `getInstances()` entirely, requiring the additional `_reconciling` guard.
- [From 0104/0106/0109/0117] Reviewer stale branch reads: consultation prompts should include the actual file tree or instruct models to search recursively, since reviewers occasionally read files from `main` instead of the feature branch worktree.

## Backward Compatibility and Migration

- [From 0056] When moving functionality to a new location (e.g., `roles/review-types/` to `consult-types/`), always implement a fallback chain that checks the new location first, then falls back to the old location with a deprecation warning. Test both paths explicitly.
- [From 0064] Hide/show iframes instead of destroy/recreate when preserving state is important. Maintain an invalidation mechanism (e.g., port change detection) to handle stale cached elements.
- [From 0106] Old migration code (e.g., v6, v7 referencing `shepherd_*`) must remain historically correct even after a rename. Only current schema and new migrations use the new names.

## Protocol Orchestration

- [From 0073] Pure YAML state format is simpler than markdown-with-frontmatter for machine-readable state. Standard format, standard libraries, no custom parsing.
- [From 0073] Signal-based transitions (`<signal>NAME</signal>`) are simple and unambiguous for LLM output parsing. "Last signal wins" resolves ambiguity when multiple signals appear in output.
- [From 0073] YAML key naming: use underscores (`spec_approval`) not hyphens (`spec-approval`) for compatibility with YAML parsing via regex.
- [From 0073] Atomic writes (tmp file + fsync + rename) prevent state file corruption on crash. Advisory file locking prevents concurrent writers.
- [From 0073] Spike work (0069 checklister, 0070 CODEV_HQ, 0072 Ralph-SPIR) provided a solid foundation for the production porch implementation. Time-boxed spikes that validate core assumptions before building production code pay dividends.
- [From 0075] Safe defaults for consultation: empty or short output from a consultation should default to REQUEST_CHANGES, not APPROVE. Silent failures should never auto-approve.
- [From 0075] Let Claude read raw consultation feedback files rather than synthesizing summaries. File path references in prompt headers are simpler and preserve full context.
- [From 0075] The build-verify cycle pattern (build artifact -> run consultation -> iterate if needed -> commit on success) is a reusable orchestration pattern that applies across all protocol phases.
- [From 0073] Multi-agent consultation caught real issues: Codex identified missing permission enforcement and BUGFIX GitHub integration; Claude found directory naming inconsistencies and signal parsing fragility concerns. Consultation is most valuable for catching gaps in scope.
- [From 0076] Existing infrastructure often already has the helper you need. The `tmuxSessionExists()` function was already implemented -- the fix was a 25-line change reusing it.
- [From 0076] Three-layer mental models matter: when debugging process lifecycle issues, identify all layers (shell -> tmux -> ttyd) and understand which layer owns which state.
- [From 0082] Before splitting a monolith into packages, verify the dependency graph is unidirectional. The Codev -> AgentFarm -> Porch flow has no circular dependencies, making extraction feasible. Start with the component that has the cleanest boundaries (porch).
- [From 0106] Porch check normalization bug: `normalizeProtocol()` merges all phases' checks into a flat `Record<string, CheckDef>`. If the review phase defines a `"tests"` check, it overrides the implement phase's modified test command. Phase-scoped check definitions would prevent override collisions.

## Debugging and Root Cause Analysis

- [From 0107] Commander.js `.alias()` does NOT hide aliases from `--help` output -- they show as `command|alias`. Use `towerCmd.addCommand(cmd, { hidden: true })` to add hidden backward-compatible commands.
- [From 0107] `body && body.name` treats `{ name: "" }` as falsy, falling through to reconnect instead of validation. Use `body && 'name' in body` for field presence checks where empty string is a meaningful (invalid) value.
- [From 0107] Nonce must be embedded in the callback URL, not the initial auth URL, so that the OAuth callback can validate state.
- [From 0109] When `ws.ping()` throws, do NOT return early and skip timeout scheduling. Fall through to arm the pong timeout -- this catches cases where `readyState` reports OPEN but the socket is in a bad state.
- [From 0109] Mock WebSocket `removeAllListeners` overrides can cause infinite recursion if the mock calls itself. Save a reference to the original method before overriding.
- [From 0109] Vitest fake timer advancement can trigger unrelated timers (e.g., reconnect backoff) when advancing past the pong timeout. Restructure tests to verify timer state rather than advancing time past secondary timer thresholds.
- [From 0113] JavaScript primitive types are copied by value when assigned to object properties. When a boolean needs to track external state (like stream closure), use a reference to the object itself (e.g., `stream.destroyed`) instead of a copied boolean variable.
- [From 0116] macOS `os.tmpdir()` returns `/var/folders/...` paths that are ~80 chars long. With Shellper socket filenames (`shellper-{uuid}.sock`), total path exceeds the `sun_path` limit of 104 bytes, causing silent `EINVAL` on `listen()`. Always use `/tmp/` directly for test socket directories.
- [From 0116] Tower's `server.listen()` callback runs after TCP bind, but the callback itself is `async` and may not complete Shellper manager initialization before the first request arrives. E2E tests need explicit readiness probes (e.g., `waitForShellperReady()`).
- [From 0116] Shellper requires both `persistent: true` and `cwd` in terminal creation API requests. Without both, the handler falls through to the non-Shellper path. Easy to miss in E2E tests.
- [From 0118] `socket.write()` returning `false` means kernel buffer is full, not that the write failed. The aggressive approach (destroy on `false`) is correct for broadcast scenarios where slow clients should not degrade output to others.

---

*Last updated: 2026-02-18 (Spec 422 — documentation sweep, Phase 3: Refinement)*
*Source: codev/reviews/*
