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
- [From 0045] Integration testing gaps slip through unit tests -- always test in the full integration environment during the Defend phase, not just with unit tests. The builder tested feature in isolation without running the full dashboard.

## Security

- [From 0048] DOMPurify for XSS protection when rendering user-provided content
- [From 0048] External links need `target="_blank" rel="noopener noreferrer"`
- [From 0055] Context matters for escaping: JS context needs different escaping than HTML context
- [From 0052] Security model documentation is essential for any system exposing HTTP endpoints, even localhost-only
- [From 0005] Multi-agent consultation is essential for security review. Both GPT-5 and Gemini independently identified shell injection vulnerabilities (using `execAsync` with string interpolation), CORS misconfiguration (`Access-Control-Allow-Origin: *`), and input validation gaps that were missed during implementation.
- [From 0005] Prefer Node built-ins over shell commands for cross-platform safety. Using `lsof` for port detection works on macOS but fails on Windows/minimal Linux; native Node `net.createServer().listen()` is portable. Using `spawn('which', [cmd])` instead of `execAsync('command -v ${command}')` prevents shell injection.
- [From 0005] Branch name sanitization is a security requirement. Spec file names flow into git branch names; without sanitization to `[a-z0-9_-]`, malicious filenames could inject shell commands.
- [From 0022] Using `subprocess.run([...])` with list arguments (not string) bypasses shell entirely, eliminating shell injection risk. This is safer than attempting to escape arguments for shell invocation.
- [From 0020] When sending messages to builder terminals, the builder might be at a shell prompt rather than Claude -- the message could execute as a shell command. Document this risk and consider using structured message wrappers.
- [From 0058] XSS prevention requires consistent escaping across all rendering paths. Shared helper functions (e.g., `escapeHtml()`) reduce the chance of missing an escape point.
- [From 0061] Multi-agent consultation caught an XSS vulnerability: unescaped file paths in the 3D viewer HTML template. User-controlled data (filenames) must always be escaped before injection into HTML.
- [From 0081] When running behind a tunnel daemon (cloudflared, ngrok, Tailscale), never bypass authentication based on `remoteAddress` being localhost. Tunnel daemons run locally and proxy remote traffic, so all localhost traffic is potentially untrusted when a tunnel is active.
- [From 0081] WebSocket authentication via subprotocol header (`Sec-WebSocket-Protocol: auth-<key>`) works when the standard `Authorization` header is unavailable (browser WebSocket API limitation). Strip the auth protocol before forwarding to upstream servers.

## Architecture

- [From 395] Prompt-based instructions beat programmatic file manipulation for flexible document generation — the builder already has context and can write natural responses, while code would need fragile parsing and placeholder logic
- [From 395] Keep specs and plans clean as forward-looking documents — append review history (consultation feedback, lessons learned) to review files, not to the documents being reviewed
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files for shared state
- [From 0039-TICK-005] Prefer CLI commands over AI agents for well-defined operations (discoverability, arg parsing, shell completion)
- [From 0034] Two-pass rendering needed for format-aware processing (e.g., table alignment)
- [From 0048] Three-container architecture (viewMode, editor, preview) provides clean separation for multi-mode UIs
- [From 0039] Embedding templates in npm packages ensures offline capability and version consistency
- [From 0060] When modularizing large files, group by concern (CSS together, JS together) not by feature
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
- [From 0021] Not all AI CLIs are agentic enough to serve as builders. Validate capabilities (tool loop, file editing, shell execution) before spawning -- non-agentic CLIs silently fail at implementation tasks rather than erroring cleanly.
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
- [From 0060] When extracting a monolithic file into modules, maintain function references carefully -- extracted functions must be globally accessible if called from inline event handlers. `sessionStorage` (not `localStorage`) is appropriate for state that should survive a page reload but not persist across sessions (used for hot-reload state preservation).
- [From 0060] CSS variables should be extracted first when modularizing styles, as they define the cascade that other files depend on.
- [From 0060] Actual implementation time was ~14 minutes vs. the 7-hour plan estimate (30x faster). Plans routinely overestimate modularization/extraction tasks when the code structure is already well-organized.
- [From 0062] When adding reverse proxy functionality, file-based features (like file browser tabs) may not work through the proxy without additional routing. Document known limitations explicitly.
- [From 0062] Derive port numbers from configuration, not hardcoded values. Codex caught a port derivation bug during consultation.
- [From 0066] The VSCode Terminal API cannot capture stdout -- this is a fundamental platform limitation, not a bug. When a core assumption of an approach turns out to be wrong, abandon it early rather than building workarounds.
- [From 0068] "Tethered Satellite" hybrid architecture (cloud control plane + local execution) addresses security (code stays local), cost (heavy compute on user hardware), offline capability, and enterprise self-hosting requirements simultaneously.
- [From 0068] YAML frontmatter + Markdown status files tracked in git provide a simpler, more auditable workflow state mechanism than databases or workflow engines (Temporal, Inngest). Git provides history, blame, and portability with zero infrastructure.
- [From 0081] The EventSource API does not support custom headers. For authenticated SSE, use `fetch()` with `ReadableStream` instead.
- [From 0081] Base64URL encoding (RFC 4648) is cleaner and more compact than standard URL encoding for path segments containing slashes and special characters.
- [From 0081] When a downstream component changes its architecture (e.g., ttyd to node-pty multiplexing), upstream proxies AND related utility functions (instance discovery, stop logic) need updating. Reviewers caught that the initial TICK change only updated proxy routing but left `getInstances()` and `stopInstance()` probing dead ports.

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
- [From 0019] Read the protocol documentation BEFORE starting implementation, not mid-way through. The TICK protocol was unfamiliar to the builder, causing incorrect commit ordering that had to be corrected after the fact.
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
- [From 0054] When specs reference external source files (e.g., Python implementation to port), verify the file is accessible from the builder worktree before starting implementation.

## Testing

- [From 0009] Verify dependencies actually export what you expect before using them
- [From 0041] Tarball-based E2E testing catches packaging issues that unit tests miss
- [From 0039-TICK-005] Regex character classes need careful design - consider all valid characters in user input
- [From 0059] Timezone handling: use local date formatting, not UTC, when displaying to users
- [From 0001] Prefer behavior testing over implementation testing to avoid overmocking. Test file system outcomes rather than individual shell commands. Control tests (verifying default behavior) should precede override tests.
- [From 0001] Use portable shell constructs to avoid BSD vs GNU differences. Cross-platform issues to watch for: `find` syntax, `stat` command flags, `timeout` vs `gtimeout` availability. Platform detection with conditional logic is the standard workaround.
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

## UI/UX

- [From 0050] Differentiate "not found" vs "empty" states to prevent infinite reload loops
- [From 0050] State-change hooks should run after every state update, not just on init
- [From 0055] Be selective about file exclusions - exclude heavyweight directories, not all dotfiles
- [From 0057] Follow git's branch naming rules - use pattern-based rejection, not whitelist
- [From 0002-001] Shell escaping in terminal multiplexers: complex content with backticks/quotes needs launch scripts
- [From 0085] xterm.js `customGlyphs: true` renders block elements (▀▄█) procedurally — crisp at any size, no font dependency
- [From scroll saga] Global terminal multiplexer flags can poison ALL sessions. Always use session-scoped settings. One global flag poisoned every session on the machine
- [From 0012] Per-session tmux configuration (`tmux set-option -t <session>`) avoids polluting the user's global tmux environment. Always scope terminal multiplexer settings to the session rather than using global flags.
- [From 0009] BroadcastChannel provides clean cross-tab communication for same-origin pages, working around cross-origin iframe restrictions that block direct postMessage.
- [From 0009] Server readiness matters for iframe loading. When creating tabs that load iframe content from newly spawned servers, poll for port readiness before returning success. A 5-second timeout with `waitForPortReady()` prevents the common "blank iframe, refresh to fix" issue.
- [From 0011] HTML-escape all user-derived content injected into templates (project names, file paths) to prevent XSS.
- [From 0019] Don't rely solely on color for status indicators -- add shape differences (diamond for blocked), pulse animations, and tooltips for accessibility. `prefers-reduced-motion` media query should be included for animation-heavy UIs.
- [From 0019] `role="status"` on elements that update every polling cycle causes screen reader chatter. Use `role="img"` with descriptive `aria-label` instead for status dots.
- [From 0030] Prism.js markdown highlighting inserts actual newline characters in output strings (not just block elements), breaking line-number synchronization. A custom regex-based "styled source" approach that keeps syntax visible but muted preserves 1:1 line mapping.
- [From 0029] Web browsers don't provide native directory pickers that return server-accessible absolute paths. For server-side path input, use a text input field rather than attempting `<input webkitdirectory>`.
- [From 0037] Tab overflow detection needs both initial check and resize handler -- use `scrollWidth > clientWidth` comparison with debounced resize handler; also update count on tab add/remove
- [From 0034] Table detection using header+separator pattern (header line with pipes, followed by separator row with dashes) avoids false positives on prose containing pipe characters
- [From 0045] Security-first approach for user content rendering: XSS protection and path validation should be built in from the start, never as a "TODO" or afterthought.
- [From 0050] Click event propagation: when moving click handlers from parent to child elements, use `event.stopPropagation()` to prevent events from bubbling to the parent.
- [From 0050] UX consistency: if you remove click behavior from an element, also remove visual indicators (cursor, hover effect). Users expect pointer + hover = clickable.
- [From 0048] Conditional CDN loading (via `document.write` inside `if` blocks) cleanly avoids loading libraries for file types that don't need them. Percentage-based scroll preservation is "good enough" -- perfect scroll mapping is unnecessary.

## Documentation

- [From 0044] Documentation synchronization burden (multiple identical files) is error-prone - consider single source
- [From 0052] Tables improve scannability for reference material (API endpoints, file purposes)
- [From 0044] Review types as separate markdown files (not inline strings) improves maintainability and allows user customization -- five files in `codev/roles/review-types/` each following consistent structure
- [From 0044] Appending type-specific prompts to base consultant role preserves personality while adding specialized focus -- better than replacing the role entirely
- [From 0052] ASCII diagrams work well for terminal-based documentation and render consistently in markdown viewers.
- [From 0052] Including actual SQLite schema SQL in documentation helps readers understand data models without reading code.
- [From 0052] Error handling and recovery mechanisms deserve their own documentation section -- real-world operation involves failures, and documenting recovery helps operators troubleshoot.

## 3-Way Reviews

- [From 0054] Each reviewer catches different aspects - Claude: spec compliance, Gemini: API correctness, Codex: practical issues
- [From 0061-002] Security vulnerabilities (XSS) often identified in 3-way review that weren't in initial implementation
- [From CMAP analysis] Codex catches security edge cases (SSRF bypass, path traversal, file permissions) that other reviewers miss; blocked in 38 rounds across Jan 30-Feb 13 window
- [From CMAP analysis] CMAP misses proxy/deployment topology bugs and React lifecycle/WebSocket timing issues — add "works behind reverse proxy?" to review checklist for HTTP specs
- [From CMAP analysis] When 2/3 approve for 3+ consecutive rounds, auto-advance with documented dissent — prevents 7-10 iteration loops (seen in 0097 Phase 7, 0101 Phase 4)
- [From CMAP analysis] Full analysis with ROI data: `codev/resources/cmap-value-analysis-2026-02.md`
- [From 0001] Multi-agent consultation must include FINAL approval on the FIXED version, not just the initial review. Presenting fixes directly to the user without re-consulting creates a gap where new issues can be introduced.
- [From 0005] Different models catch different categories of issues: GPT-5 found shell injection and input validation gaps; Gemini found race conditions and CORS misconfiguration. Using both provides broader coverage than either alone.
- [From 0012] For small, well-defined changes (like adding a single tmux option at 6 locations), end-only consultation is sufficient. Both reviewers approved without changes, confirming that the task scope matches the consultation effort.
- [From 0009] End-only consultation caught critical issues (hardcoded ports, builder path resolution, double API calls) that would have been missed without review. Even for seemingly simple TICK implementations, consultation provides value.
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

## Backward Compatibility and Migration

- [From 0056] When moving functionality to a new location (e.g., `roles/review-types/` to `consult-types/`), always implement a fallback chain that checks the new location first, then falls back to the old location with a deprecation warning. Test both paths explicitly.
- [From 0064] Hide/show iframes instead of destroy/recreate when preserving state is important. Maintain an invalidation mechanism (e.g., port change detection) to handle stale cached elements.

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

---

*Last updated: 2026-02-18 (Spec 422 — documentation sweep, batch 1)*
*Source: codev/reviews/*
