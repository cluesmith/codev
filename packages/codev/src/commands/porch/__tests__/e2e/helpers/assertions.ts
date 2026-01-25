/**
 * E2E Test Assertions
 *
 * Custom assertions for porch E2E tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import type { TestContext } from './setup.js';

/**
 * Assert that a spec file was created for the test project.
 */
export function assertSpecExists(ctx: TestContext): void {
  const specPattern = path.join(
    ctx.tempDir,
    'codev',
    'specs',
    `${ctx.projectId}-*.md`
  );

  const { globSync } = require('glob');
  const matches = globSync(specPattern);

  expect(matches.length).toBeGreaterThan(0);
}

/**
 * Assert that a plan file was created for the test project.
 */
export function assertPlanExists(ctx: TestContext): void {
  const planPattern = path.join(
    ctx.tempDir,
    'codev',
    'plans',
    `${ctx.projectId}-*.md`
  );

  const { globSync } = require('glob');
  const matches = globSync(planPattern);

  expect(matches.length).toBeGreaterThan(0);
}

/**
 * Assert that review files exist for a phase.
 */
export function assertReviewFilesExist(
  ctx: TestContext,
  phase: string,
  minCount: number = 1
): void {
  const projectDir = path.join(
    ctx.tempDir,
    'codev',
    'projects',
    `${ctx.projectId}-${ctx.projectTitle}`
  );

  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  const files = fs.readdirSync(projectDir);
  const reviewFiles = files.filter(
    (f) => f.includes(phase) && f.endsWith('.txt')
  );

  expect(reviewFiles.length).toBeGreaterThanOrEqual(minCount);
}

/**
 * Assert that porch state is at a specific phase.
 */
export function assertPhase(ctx: TestContext, expectedPhase: string): void {
  const { getTestProjectState } = require('./setup.js');
  const state = getTestProjectState(ctx);

  expect(state).not.toBeNull();
  expect(state?.phase).toBe(expectedPhase);
}

/**
 * Assert that a gate is pending.
 */
export function assertGatePending(ctx: TestContext, gateName: string): void {
  const { getTestProjectState } = require('./setup.js');
  const state = getTestProjectState(ctx);

  expect(state).not.toBeNull();
  expect(state?.gates?.[gateName]?.status).toBe('pending');
}

/**
 * Assert that a gate was approved.
 */
export function assertGateApproved(ctx: TestContext, gateName: string): void {
  const { getTestProjectState } = require('./setup.js');
  const state = getTestProjectState(ctx);

  expect(state).not.toBeNull();
  expect(state?.gates?.[gateName]?.status).toBe('approved');
}

/**
 * Assert iteration count.
 */
export function assertIteration(ctx: TestContext, expectedIteration: number): void {
  const { getTestProjectState } = require('./setup.js');
  const state = getTestProjectState(ctx);

  expect(state).not.toBeNull();
  expect(state?.iteration).toBe(expectedIteration);
}

/**
 * Assert history has entries (feedback loop worked).
 */
export function assertHistoryNotEmpty(ctx: TestContext): void {
  const { getTestProjectState } = require('./setup.js');
  const state = getTestProjectState(ctx);

  expect(state).not.toBeNull();
  expect(Array.isArray(state?.history)).toBe(true);
  expect((state?.history as unknown[]).length).toBeGreaterThan(0);
}
