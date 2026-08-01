/**
 * Re-orientation assembly — invariant R3 (Spec 1273).
 *
 * R3: the re-orientation always carries role frame, protocol, mode, project
 * identity, worktree, branch, the state-file pointer, and — for porch lanes —
 * the porch re-entry instruction. **There is no code path that emits a partial
 * frame**: a missing input throws a named error rather than being omitted.
 *
 * That strictness is the point. A re-orientation missing its frame does not
 * crash anything; it produces a builder with a fresh window that does not know
 * it is a builder, what protocol governs it, or what porch expects next. The
 * drift is silent and only shows up later as off-protocol work.
 *
 * Two parts, with a fixed division:
 *
 *   - `inline` — compact, sent as a message. Satisfies R3 on its own. Kept small
 *     because the message channel writes ≥4-line payloads line-by-line at 10ms
 *     intervals and multi-line writes risk paste detection (#584).
 *   - `longForm` — written to `.builder-reorient.md`. This IS the spawn prompt:
 *     `buildSpawnPrompt` is the same `buildPromptFromTemplate` the fresh-launch
 *     path calls, so the builder gets the same protocol/phase framing a fresh
 *     spawn delivers — through a file rather than a prompt argument.
 *
 * The role's *full text* is deliberately not inlined. Under the Claude harness it
 * is injected via `--append-system-prompt`, a process flag that `/clear` does not
 * touch, so it survives the reset intact. R3 is satisfied by the identity block
 * regardless, so the guarantee does not rest on that harness detail.
 */

import { REORIENT_FILE_NAME } from './constants.js';
import type { ResolvedBuilderContext } from './context.js';
import type { TemplateContext } from '../spawn-roles.js';

// ============================================================================
// Ports
// ============================================================================

/**
 * Renders the protocol's builder prompt. Injected so this module stays pure and
 * so the orchestrator can wire it to the real `buildPromptFromTemplate`.
 */
/**
 * Renders the porch re-entry guidance. Wired in phase 6 to `buildResumeNotice`,
 * so reset and spawn share **one** copy of that text.
 *
 * Reuse matters beyond tidiness: `buildResumeNotice` carries the fallback
 * instruction for when porch reports "not found" (run `porch init`). A restated
 * version drops it, and the two surfaces then drift apart with no test noticing.
 */
export type ResumeNoticePort = (projectId: string) => string;

/**
 * Typed against the REAL `TemplateContext` rather than a hand-rolled copy.
 *
 * The local copy was how issue metadata went missing: the port's shape drifted
 * from what the templates actually consume, and nothing type-checked the gap.
 * Importing the canonical type means any field added to `TemplateContext` is
 * visible here, and a field this module fails to populate is a deliberate
 * omission rather than an oversight nobody can see.
 */
export type SpawnPromptPort = (protocol: string, context: TemplateContext) => string;

/**
 * Issue metadata for the spawn template.
 *
 * Every issue-driven protocol's builder prompt renders `{{issue.number}}`,
 * `{{issue.title}}` and `{{issue.body}}` — and for BUGFIX and AIR the issue body
 * *is* the spec. Omitting it would leave a reset builder on those lanes without
 * the requirements it is implementing, which is the opposite of spawn-equivalent.
 *
 * Fetched by the orchestrator (I/O stays out of this module) and passed in.
 */
export interface IssuePayload {
  number: number | string;
  title: string;
  body: string;
}

// ============================================================================
// Result
// ============================================================================

export interface ReorientationPayload {
  /** Compact frame delivered as a message. Satisfies R3 by itself. */
  inline: string;
  /** Full spawn-quality prompt, written to the worktree before the clear (R1). */
  longForm: string;
  /** Worktree-relative path the inline frame points at. */
  longFormFileName: string;
}

/** Thrown when a required frame element cannot be produced. Never swallowed. */
export class ReorientationAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReorientationAssemblyError';
  }
}

/**
 * Elements every inline frame must contain, as literal markers.
 *
 * Assembly validates the rendered payload against this list before returning, so
 * adding an element here without producing it fails the tests rather than
 * silently shipping a frame that is missing it.
 */
export const REQUIRED_INLINE_MARKERS = [
  'CONTEXT RESET',
  'You are a Builder',
  // The spec requires the identity block to name WHICH role document governs
  // the builder, not merely that one does.
  '.builder-role.md',
  'Protocol:',
  'Mode:',
  'Worktree:',
  'Branch:',
  'State file:',
  'Full re-orientation:',
] as const;

/**
 * Markers required *when the context supplies the corresponding fact*.
 *
 * Project identity and porch re-entry are not universally applicable — a task or
 * shell builder has neither — but on a porch lane they are as load-bearing as
 * the protocol name, and omitting them would leave a reset builder unable to
 * find its own project. So they are required conditionally rather than left
 * optional: "missing input is an abort, not an omission" applies to whatever the
 * lane actually has.
 */
export function conditionalInlineMarkers(context: ResolvedBuilderContext): string[] {
  const markers: string[] = [];
  // Project ID is required, not just the directory stem: porch commands take the
  // id, and a reset builder should not have to parse it out of a slug.
  if (context.porch) markers.push('Project ID:', 'Project:', 'porch next');
  if (context.issueNumber) markers.push('Issue:');
  return markers;
}

// ============================================================================
// Assembly
// ============================================================================

export interface AssembleOptions {
  context: ResolvedBuilderContext;
  /** Absolute path of the verified state file. */
  statePath: string;
  /** Architect addendum from --note / --file. */
  addendum?: string;
  buildSpawnPrompt: SpawnPromptPort;
  /** Porch re-entry guidance; omitted only for non-porch lanes. */
  buildResumeNotice?: ResumeNoticePort;
  /**
   * Issue metadata, when the orchestrator could fetch it. Absence on an
   * issue-backed lane is surfaced in the long form with a recovery instruction
   * rather than silently dropped — see `buildLongForm`.
   */
  issue?: IssuePayload;
}

export function assembleReorientation(options: AssembleOptions): ReorientationPayload {
  const { context, statePath, addendum, buildSpawnPrompt } = options;

  requireField(context.builderId, 'builderId');
  requireField(context.worktree, 'worktree');
  requireField(context.branch, 'branch');
  requireField(context.protocol, 'protocol');
  requireField(context.mode, 'mode');
  requireField(statePath, 'statePath');

  // Porch identity is checked field by field, not just for the presence of the
  // `porch` object. The marker validation below matches on LABELS, so an empty
  // projectId still renders `Project ID:` and satisfies it — a frame that looks
  // complete and tells the builder nothing. Presence of a label is not presence
  // of a value.
  if (context.porch) {
    requireField(context.porch.projectId, 'porch.projectId');
    requireField(context.porch.projectName, 'porch.projectName');
    requireField(context.porch.phase, 'porch.phase');
  }

  const longForm = buildLongForm(options);
  const inline = buildInline(options);

  // R3 is enforced here, not asserted in a comment: a frame that lost an element
  // during a refactor fails at assembly rather than reaching a live builder.
  const expected = [...REQUIRED_INLINE_MARKERS, ...conditionalInlineMarkers(context)];
  const missing = expected.filter(marker => !inline.includes(marker));
  if (missing.length > 0) {
    throw new ReorientationAssemblyError(
      `Assembled re-orientation is missing required element(s): ${missing.join(', ')}. ` +
        `Refusing to clear a builder's context without a complete frame (R3).`,
    );
  }

  return { inline, longForm, longFormFileName: REORIENT_FILE_NAME };
}

function requireField(value: unknown, name: string): void {
  if (value === undefined || value === null || value === '') {
    throw new ReorientationAssemblyError(
      `Cannot assemble a re-orientation without '${name}'. ` +
        `Refusing to emit a partial frame — a builder re-oriented without it would drift silently (R3).`,
    );
  }
}

// ============================================================================
// Inline frame
// ============================================================================

function buildInline(options: AssembleOptions): string {
  const { context: c, statePath, addendum } = options;

  const lines: string[] = [
    '## CONTEXT RESET — re-orientation',
    '',
    'Your conversation history was cleared. Everything you knew that was not written',
    'down is gone. Do not try to recall it; read the files below instead.',
    '',
    // Name the role document rather than gesturing at it: a builder with no
    // conversation history cannot resolve "your role document" to a file, and
    // the spec requires the identity block to say WHICH document governs it.
    // `.builder-role.md` is the copy the harness actually injected at launch
  // (written on spawn, and refreshed on resume since #1267 — the clean-exit
  // relaunch injects it too).
    'You are a Builder. Your role document is `.builder-role.md` at the worktree root',
    '(the builder role, injected into your system prompt at spawn and still in effect).',
    '',
    `- Protocol: ${c.protocol.toUpperCase()}`,
    `- Mode: ${c.mode.toUpperCase()}`,
  ];

  if (c.issueNumber) lines.push(`- Issue: #${c.issueNumber}`);
  if (c.porch) {
    // Project ID is stated explicitly, not left implicit in the directory stem:
    // `porch status`/`porch next` take the id, and a reset builder should not
    // have to parse it back out of a slug to address its own project.
    lines.push(`- Project ID: ${c.porch.projectId}`);
    lines.push(`- Project: ${c.porch.projectName} (phase: ${c.porch.phase}${c.porch.currentPlanPhase ? `, plan phase: ${c.porch.currentPlanPhase}` : ''})`);
  }
  if (c.specPath) lines.push(`- Spec: ${c.specPath}`);
  if (c.planPath) lines.push(`- Plan: ${c.planPath}`);

  lines.push(
    `- Worktree: ${c.worktree}`,
    `- Branch: ${c.branch}`,
    '',
    '### Do this now, in order',
    '',
    `1. State file: read \`${statePath}\` **in full** before acting. It is the working`,
    '   state your previous session wrote for exactly this moment — receipts, open',
    '   questions, standing orders. Untracked: do not stage or commit it.',
    `2. Full re-orientation: read \`${REORIENT_FILE_NAME}\` at the worktree root for the`,
    '   complete protocol framing.',
  );

  if (c.porch) {
    // Short pointer inline; the full guidance — including the `porch init`
    // fallback — is carried verbatim in the long form from buildResumeNotice,
    // so there is exactly one copy of that text in the codebase.
    lines.push(`3. Run \`porch next\` to confirm where the protocol actually stands (full re-entry`, `   guidance is in ${REORIENT_FILE_NAME}), and continue.`);
  } else {
    lines.push('3. Continue from the next action named in the state file.');
  }

  if (addendum && addendum.trim() !== '') {
    lines.push(
      '',
      '### From the architect (this post-dates your save)',
      '',
      addendum.trim(),
    );
  }

  return lines.join('\n');
}

// ============================================================================
// Long form
// ============================================================================

/**
 * Reconstruct `input_description` (and `task_text`) the way the matching spawn
 * entry point would.
 *
 * `{{input_description}}` is the FIRST line of every protocol's builder prompt
 * (`bugfix/air/aspir/spir/builder-prompt.md:3`), so getting it wrong mis-frames
 * the whole document — the reset builder is told it is doing something other
 * than what it is doing. Spawn produces four distinct values, one per entry
 * point, and this mirrors all four rather than approximating with two:
 *
 *   - spec-driven   → `spawn.ts:455`  (also the lane that attaches an issue)
 *   - ad-hoc task   → `spawn.ts:543`  (carries `task_text` as well)
 *   - issue-driven  → `spawn.ts:837`  (BUGFIX/AIR; the issue body IS the spec)
 *   - protocol-only → `spawn.ts:607`
 *
 * **Order is load-bearing, and not the obvious one.** A `--task` builder gets a
 * porch project keyed on its own builder id, so `issueNumber` is populated for
 * it too (`context.ts` falls back to `porch.projectId`). Testing `issueNumber`
 * before `taskText` would therefore route every task builder down the
 * issue-driven branch and announce a GitHub issue that does not exist. Spec wins
 * over both because the spec-driven spawn path sets its own description even
 * when an issue is attached.
 */
function buildInputDescription(
  c: ResolvedBuilderContext,
): Pick<TemplateContext, 'input_description' | 'task_text'> {
  if (c.specPath) return { input_description: `the feature specified in ${c.specPath}` };
  if (c.taskText) return { input_description: 'an ad-hoc task', task_text: c.taskText };
  if (c.issueNumber) return { input_description: `work for GitHub Issue #${c.issueNumber}` };
  return { input_description: `running the ${c.protocol.toUpperCase()} protocol` };
}

function buildLongForm(options: AssembleOptions): string {
  const { context: c, statePath, addendum, buildSpawnPrompt, buildResumeNotice, issue } = options;

  let spawnPrompt: string;

  // The bare `--task` lane has NO protocol template, and asking for one is not a
  // near-miss — it is a category error. `afx spawn --task` without `--protocol`
  // takes spawn.ts's `else` branch and builds the prompt directly from the task
  // text (`spawn.ts:551`); there is no `protocols/task/builder-prompt.md` to
  // render, so the live e2e died on
  // `Protocol "task" has no builder-prompt.md`.
  //
  // Identified by a POSITIVE fact rather than by catching that error, and
  // rather than by `taskText && !porch`: `initPorchInWorktree` is non-fatal, so
  // a `--task --protocol X` builder whose porch init FAILED also has task text
  // and no porch. `isBareTask` is established from the prompt file itself (see
  // context.ts), which carries the rendered template for that lane regardless.
  if (c.isBareTask) {
    const longFormTask = [
      'You are a Builder. Read codev/roles/builder.md for your full role definition.',
      '',
      '# Task',
      '',
      c.taskText,
    ].join('\n');
    return assembleLongFormDocument(options, longFormTask);
  }

  try {
    spawnPrompt = buildSpawnPrompt(c.protocol, {
      protocol_name: c.protocol.toUpperCase(),
      mode: c.mode,
      mode_soft: c.mode === 'soft',
      mode_strict: c.mode === 'strict',
      project_id: c.porch?.projectId,
      ...buildInputDescription(c),
      ...(c.specPath && c.specName ? { spec: { path: c.specPath, name: c.specName } } : {}),
      ...(c.planPath && c.specName ? { plan: { path: c.planPath, name: c.specName } } : {}),
      // Issue-driven protocols render {{issue.*}} in their builder prompt, and
      // on BUGFIX/AIR the body IS the spec. Forwarding it is what makes the long
      // form genuinely spawn-equivalent rather than spawn-shaped.
      ...(issue ? { issue: { number: issue.number, title: issue.title, body: issue.body } } : {}),
    });
  } catch (err) {
    // Abort rather than degrade: a long form without the protocol framing is the
    // partial frame R3 forbids, and it would be delivered to a builder with no
    // context left to notice the gap.
    throw new ReorientationAssemblyError(
      `Could not render the ${c.protocol} builder prompt for the long-form re-orientation: ` +
        `${err instanceof Error ? err.message : String(err)}. Refusing to clear without it (R1/R3).`,
    );
  }

  return assembleLongFormDocument(options, spawnPrompt);
}

/**
 * Wrap a rendered prompt body in the reset header, state-file pointer, addendum
 * and porch re-entry.
 *
 * Shared by both lanes so the framing cannot drift between them: the bare
 * `--task` lane supplies spawn's task prompt, every other lane supplies the
 * rendered protocol template. Only the BODY differs — everything R3 requires is
 * assembled here, once.
 */
function assembleLongFormDocument(options: AssembleOptions, promptBody: string): string {
  const { context: c, statePath, addendum, buildResumeNotice, issue } = options;

  const header = [
    '<!-- Written by `afx reset` (Spec 1273). Untracked; regenerated on every reset. -->',
    '',
    '# Re-orientation after context reset',
    '',
    `Your conversation history was cleared deliberately, to give you a fresh window`,
    `without losing your working state. This file restores the protocol framing a`,
    `fresh spawn would have given you; \`${statePath}\` holds what your previous`,
    `session actually knew.`,
    '',
    '## Read order',
    '',
    `1. \`${statePath}\` — your working state (receipts, open questions, standing orders).`,
    '2. The rest of this file — protocol framing, identical to a fresh spawn prompt.',
    c.porch ? '3. `porch next` — the authoritative protocol state.' : '3. The next action named in your state file.',
    '',
    '## Current position',
    '',
    `- Builder: ${c.builderId}`,
    `- Protocol: ${c.protocol.toUpperCase()} (${c.mode})`,
    `- Worktree: ${c.worktree}`,
    `- Branch: ${c.branch}`,
  ];

  if (c.porch) {
    header.push(
      `- Porch project ID: ${c.porch.projectId}`,
      `- Porch project: ${c.porch.projectName}`,
      `- Phase: ${c.porch.phase}${c.porch.currentPlanPhase ? ` (plan phase: ${c.porch.currentPlanPhase})` : ''}`,
    );
  }
  if (c.issueNumber) header.push(`- Issue: #${c.issueNumber}`);

  header.push(
    '',
    `Protocol and mode were resolved from ${c.protocolSource} and ${c.modeSource} respectively.`,
  );

  // An issue-backed lane whose issue could not be fetched keeps a VISIBLE gap
  // with a recovery instruction, rather than a silently shorter prompt. On
  // BUGFIX/AIR the issue body is the spec, so a reset builder must be told the
  // requirements are missing instead of inferring them from what remains.
  if (c.issueNumber && !issue) {
    header.push(
      '',
      `> **Issue #${c.issueNumber} could not be fetched when this file was written**, so the`,
      `> protocol framing below does not include its title or body. On issue-driven`,
      `> protocols that body carries the requirements. Read it before continuing:`,
      `> \`gh issue view ${c.issueNumber}\`.`,
    );
  }

  if (addendum && addendum.trim() !== '') {
    header.push(
      '',
      '## From the architect (post-dates your save)',
      '',
      addendum.trim(),
    );
  }

  // Porch re-entry, verbatim from the single source shared with spawn. Reset must
  // not restate it: buildResumeNotice carries the `porch init` fallback for when
  // porch reports "not found", and a restated copy silently drops it.
  if (c.porch) {
    if (!buildResumeNotice) {
      throw new ReorientationAssemblyError(
        `Cannot assemble a re-orientation for porch project '${c.porch.projectName}' without the ` +
          `porch re-entry notice. Refusing to emit a frame that leaves a porch-driven builder ` +
          `without its re-entry instruction (R3).`,
      );
    }
    header.push('', '---', '', buildResumeNotice(c.porch.projectId).trim());
  }

  header.push('', '---', '', '## Protocol framing (as delivered at spawn)', '');

  return `${header.join('\n')}\n${promptBody}\n`;
}
