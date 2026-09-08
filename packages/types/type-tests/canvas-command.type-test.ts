/**
 * Compile-time guard for the canvas command contracts (spec 1401, phase 1).
 *
 * This file is never executed and never shipped: it lives outside `src/` because
 * `packages/types` compiles `src/**\/*` into `dist/` and publishes both `src` and `dist`, so a
 * guard under `src/` would land in consumers' node_modules. It is checked by its own tsconfig
 * (`pnpm --filter @cluesmith/codev-types check-types:tests`) rather than an `exclude`, which
 * would silently drop it from the very check it exists to perform.
 *
 * What it protects: `TraversalCommand` is defined with `Extract` and `NonTraversalCommand`
 * with `Exclude`, so a command added to `CanvasCommand` would fall into the non-traversal
 * complement SILENTLY — `count` would quietly stop applying to a command that may well need
 * it. The exhaustive classification map below forces that decision to be made explicitly:
 * adding a command to the union breaks this file until someone classifies it.
 */

import type {
  CanvasCommand,
  TraversalCommand,
  NonTraversalCommand,
  CanvasCommandErrorCode,
  CanvasCommandClientErrorCode,
  CanvasCommandResult,
  CanvasCommandClientResult,
} from '../src/canvas-command.js';

/** True only when A and B are the identical type (not merely mutually assignable). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

/**
 * Every command, classified explicitly. `satisfies Record<CanvasCommand, ...>` makes this
 * exhaustive: a new command in the union is a missing-key compile error here.
 */
const CLASSIFICATION = {
  'block-next': 'traversal',
  'block-prev': 'traversal',
  'comment-next': 'traversal',
  'comment-prev': 'traversal',
  'heading-next': 'traversal',
  'heading-prev': 'traversal',
  'column-forward': 'traversal',
  'column-back': 'traversal',
  'viewport-down': 'traversal',
  'viewport-up': 'traversal',
  'doc-start': 'non-traversal',
  'doc-end': 'non-traversal',
  'composer-open': 'non-traversal',
  'composer-submit': 'non-traversal',
  'composer-cancel': 'non-traversal',
  'composer-open-or-submit': 'non-traversal',
  'reading-mode-toggle': 'non-traversal',
} as const satisfies Record<CanvasCommand, 'traversal' | 'non-traversal'>;

type ClassifiedAs<Kind extends 'traversal' | 'non-traversal'> = keyof {
  [K in CanvasCommand as (typeof CLASSIFICATION)[K] extends Kind ? K : never]: true;
};

/** The map and the exported types must agree, in both directions. */
export type _TraversalMatchesClassification = Expect<
  Equal<ClassifiedAs<'traversal'>, TraversalCommand>
>;
export type _NonTraversalMatchesClassification = Expect<
  Equal<ClassifiedAs<'non-traversal'>, NonTraversalCommand>
>;

/** The two halves must partition the vocabulary with nothing lost and nothing overlapping. */
export type _PartitionIsComplete = Expect<
  Equal<TraversalCommand | NonTraversalCommand, CanvasCommand>
>;
export type _PartitionIsDisjoint = Expect<
  Equal<Extract<TraversalCommand, NonTraversalCommand>, never>
>;

/**
 * `unreachable` is client-synthesized, so Tower must not be able to type it as an answer.
 * If the wire and client unions are ever collapsed into one, these two stop agreeing.
 */
export type _UnreachableIsNotAWireCode = Expect<
  Equal<Extract<CanvasCommandErrorCode, 'unreachable'>, never>
>;
export type _UnreachableIsAClientCode = Expect<
  Equal<Extract<CanvasCommandClientErrorCode, 'unreachable'>, 'unreachable'>
>;

/** Clients see a superset: any wire result is a valid client result, but not the reverse. */
export type _WireResultIsAClientResult = Expect<
  CanvasCommandResult extends CanvasCommandClientResult ? true : false
>;
export type _ClientResultIsNotAWireResult = Expect<
  CanvasCommandClientResult extends CanvasCommandResult ? false : true
>;

/** Keeps the classification map referenced; it is the exhaustiveness guard's payload. */
export type _Classification = typeof CLASSIFICATION;
