/**
 * Unit tests for getProjectSummary() — three-tier fallback logic.
 *
 * Tests: GitHub issue title → spec file heading → status.yaml title → null
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock the forge utility before importing the module under test
const mockFetchIssue = vi.hoisted(() => vi.fn());
vi.mock('../lib/github.js', () => ({
  fetchIssue: mockFetchIssue,
  fetchGitHubIssue: mockFetchIssue, // deprecated alias
}));

import { getProjectSummary } from '../commands/porch/prompts.js';

describe('getProjectSummary', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `summary-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(testDir, { recursive: true });
    mockFetchIssue.mockReset();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns GitHub issue title when issue exists', async () => {
    mockFetchIssue.mockResolvedValue({
      title: 'Project Management Rework',
      body: 'Some body',
      state: 'OPEN',
      comments: [],
    });

    const result = await getProjectSummary(testDir, '0126');
    expect(result).toBe('Project Management Rework');
    expect(mockFetchIssue).toHaveBeenCalledWith(126);
  });

  it('falls back to spec file heading when GitHub fails', async () => {
    mockFetchIssue.mockResolvedValue(null);

    // Create a spec file
    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0126-project-management-rework.md'),
      '# Specification: Project Management Rework\n\nSome content here.',
    );

    const result = await getProjectSummary(testDir, '0126');
    expect(result).toBe('Project Management Rework');
  });

  it('falls back to spec file heading without "Specification:" prefix', async () => {
    mockFetchIssue.mockResolvedValue(null);

    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0042-feature-name.md'),
      '# My Feature Name\n\nDescription.',
    );

    const result = await getProjectSummary(testDir, '0042');
    expect(result).toBe('My Feature Name');
  });

  it('falls back to status.yaml title when no spec file exists', async () => {
    mockFetchIssue.mockResolvedValue(null);

    const result = await getProjectSummary(testDir, '0099', 'my-fallback-title');
    expect(result).toBe('my-fallback-title');
  });

  it('returns null when nothing exists', async () => {
    mockFetchIssue.mockResolvedValue(null);

    const result = await getProjectSummary(testDir, '0099');
    expect(result).toBeNull();
  });

  it('returns null for non-numeric project IDs with no spec file', async () => {
    // Non-numeric ID means GitHub fetch is skipped
    const result = await getProjectSummary(testDir, 'abc');
    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('skips GitHub when issue has no title', async () => {
    mockFetchIssue.mockResolvedValue({
      title: '',
      body: '',
      state: 'OPEN',
      comments: [],
    });

    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0010-test.md'),
      '# Test Feature\n\nContent.',
    );

    const result = await getProjectSummary(testDir, '0010');
    expect(result).toBe('Test Feature');
  });

  it('handles spec file with dot separator', async () => {
    mockFetchIssue.mockResolvedValue(null);

    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0050.some-feature.md'),
      '# Some Feature\n\nContent.',
    );

    const result = await getProjectSummary(testDir, '0050');
    expect(result).toBe('Some Feature');
  });

  it('prefers GitHub title over spec file', async () => {
    mockFetchIssue.mockResolvedValue({
      title: 'GitHub Title',
      body: '',
      state: 'OPEN',
      comments: [],
    });

    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0005-test.md'),
      '# Spec File Title\n\nContent.',
    );

    const result = await getProjectSummary(testDir, '0005', 'yaml-title');
    expect(result).toBe('GitHub Title');
  });

  it('prefers spec file over status.yaml title', async () => {
    mockFetchIssue.mockResolvedValue(null);

    const specsDir = path.join(testDir, 'codev', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '0005-test.md'),
      '# Spec Title\n\nContent.',
    );

    const result = await getProjectSummary(testDir, '0005', 'yaml-title');
    expect(result).toBe('Spec Title');
  });
});
