/**
 * Context-refresh boundary resolution and task emission (Spec 1470).
 *
 * ## What a boundary is, and why it is recorded rather than inferred
 *
 * A boundary is a moment porch already transitions the state machine, at which a
 * builder's context can be discarded without losing anything: the spec, the plan,
 * `status.yaml`, the thread narrative and git carry the durable state, so a
 * refreshed builder re-orients from disk rather than from memory.
 *
 * The refresh is DESTRUCTIVE — it ends in `/clear`, which has no undo — so it must
 * fire at most once per boundary. Porch transitions can loop: issue #1408 saw
 * verify-approval reset every plan phase back to `pending`, which would replay
 * every plan-phase advance. A side effect that wipes context cannot be guarded by
 * inferring "we must already have done this" from phase or iteration; it has to be
 * a RECORDED FACT. That is what `context_refreshes` in `status.yaml` is.
 *
 * ## Where at-most-once actually comes from
 *
 * Not from a lock or a guard, but from control flow. Each transition site mutates
 * the phase fields AND appends the boundary record in ONE `writeStateAndCommit`,
 * then returns the refresh task INSTEAD of recursing into `next()`. The next
 * `porch next` reads a state where the boundary is already recorded, so
 * {@link hasRefreshed} is true and the normal path runs. There is no window in
 * which the record and the transition disagree, because they are the same write.
 *
 * ## Failure semantics: consumed means consumed
 *
 * The boundary is recorded when the task is EMITTED, not when the refresh
 * succeeds. A refresh that fails, or that the builder never runs, is never
 * retried. That is deliberate:
 *
 *   - The builder-side command never writes `status.yaml` (only porch does), so
 *     there is no completion signal to model and no way for a failed refresh to
 *     corrupt protocol state.
 *   - A missed refresh costs context and nothing else. A repeated one costs a
 *     builder's working memory, over and over, with nobody watching.
 *
 * Asymmetric costs, so the design fails toward doing nothing.
 */

import { selfRefreshInvocation } from '../../lib/self-refresh-invocation.js';
import type { ContextRefreshConfig, PorchTask, ProjectState, Protocol } from './types.js';

// ============================================================================
// Boundary identifiers
// ============================================================================

/**
 * Identifier for entering a protocol phase.
 *
 * Derived from the transition rather than from a configured label, so the record
 * in `status.yaml` cannot drift from the event that produced it.
 */
export function enterBoundary(phaseId: string): string {
  return `enter:${phaseId}`;
}

/** Identifier for advancing INTO a given plan phase. */
export function planPhaseBoundary(planPhaseId: string): string {
  return `plan-phase:${planPhaseId}`;
}

// ============================================================================
// Declaration lookup
// ============================================================================

/**
 * Is a phase-entry boundary declared for this protocol?
 *
 * Inspects the FIELDS, never the presence of the `context_refresh` object.
 * `context_refresh: {}` is valid and declares nothing, so a truthiness check on
 * the object would report every boundary as declared for a protocol that opted
 * into none of them.
 */
export function declaresEnter(protocol: Protocol, phaseId: string): boolean {
  const config: ContextRefreshConfig | undefined = protocol.context_refresh;
  return Array.isArray(config?.on_enter) && config.on_enter.includes(phaseId);
}

/** Is the plan-phase-advance boundary declared for this protocol? */
export function declaresPlanPhaseAdvance(protocol: Protocol): boolean {
  return protocol.context_refresh?.on_plan_phase_advance === true;
}

// ============================================================================
// The record
// ============================================================================

/** Has this boundary already been refreshed for this project? */
export function hasRefreshed(state: ProjectState, boundary: string): boolean {
  return (state.context_refreshes ?? []).some(r => r.boundary === boundary);
}

/**
 * Record a boundary on the state object.
 *
 * Mutates rather than writing: the caller folds this into the SAME
 * `writeStateAndCommit` as the transition itself, which is what makes the record
 * and the transition atomic. A separate write here would open exactly the window
 * this design closes.
 */
export function recordRefresh(state: ProjectState, boundary: string, now: string): void {
  if (!state.context_refreshes) state.context_refreshes = [];
  if (hasRefreshed(state, boundary)) return;
  state.context_refreshes.push({ boundary, at: now });
}

// ============================================================================
// Decision
// ============================================================================

/**
 * Should a refresh fire for `boundary`, and is it declared?
 *
 * Deliberately does NOT consider how much context the builder has used. The spec
 * fixes always-fire-at-configured-boundaries over threshold triggering:
 * thresholds would need harness introspection porch does not have, and would make
 * the behavior non-deterministic and untestable. An unnecessary refresh at a
 * clean boundary costs a re-read of artifacts the builder can already see.
 */
export function shouldRefresh(
  state: ProjectState,
  declared: boolean,
  boundary: string,
): boolean {
  return declared && !hasRefreshed(state, boundary);
}

// ============================================================================
// The task
// ============================================================================

/**
 * The single task emitted at a boundary.
 *
 * Deliberately does NOT instruct `porch done`. A refresh is not a build: `porch
 * done` would validate checks and advance the build state, which is wrong at a
 * moment when nothing was built. The builder refreshes and then re-enters through
 * `porch next`, which is also what the post-clear re-entry frame says — so both
 * paths converge on the same next command whether or not the clear lands.
 */
export function buildRefreshTask(boundary: string): PorchTask {
  // Single source: see `lib/self-refresh-invocation.ts` for why this is not
  // typed out here. Two hand-written copies have already dropped the flag.
  const invocation = selfRefreshInvocation(boundary);
  return {
    subject: 'Refresh your context',
    activeForm: 'Refreshing context',
    description: [
      `CONTEXT REFRESH BOUNDARY: \`${boundary}\``,
      '',
      'You have reached a protocol boundary where your context can be safely refreshed.',
      'Your durable state is already on disk — the spec, the plan, `status.yaml`, your',
      'thread narrative and git history — so a fresh context re-orients from artifacts',
      'rather than from memory.',
      '',
      'Run the builder-refresh procedure:',
      '',
      '```bash',
      `${invocation.begin}   # issue the challenge`,
      '# ...write your working state to the file it names...',
      `${invocation.execute}   # verify, then clear and re-orient`,
      '```',
      '',
      'Pass `--boundary` on BOTH commands. It binds the challenge to this boundary, so a',
      'challenge left behind by an aborted refresh cannot be used to clear you at a later',
      'one — against a save describing work that has since moved on.',
      '',
      'If your harness provides the `/builder-refresh` skill, invoke that instead — it',
      'sequences the same steps.',
      '',
      'IMPORTANT:',
      `- This boundary is already recorded in \`status.yaml\`. It will NOT fire again,`,
      '  whether the refresh succeeds or fails.',
      '- Do NOT run `porch done` for this task. A refresh is not a build.',
      '- If the refresh REFUSES (it fails safe rather than clearing on an unverified',
      '  save), you keep your context. Report the refusal to the architect with',
      '  `afx send architect "..."` and continue — run `porch next` for your normal tasks.',
      '- After a successful refresh your next instruction arrives automatically. It will',
      '  tell you to run `porch next`.',
    ].join('\n'),
    sequential: true,
  };
}
