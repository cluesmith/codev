/**
 * Dead Code Prevention Tests
 *
 * These tests ensure that removed code doesn't accidentally get reintroduced.
 * Add patterns here when removing dead code to prevent resurrection.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Dead Code Prevention', () => {
  describe('Activity Summary (Spec 0059 - removed in Spec 0074)', () => {
    it('should not contain ActivitySummary code in dashboard-server.ts', () => {
      const dashboardServerPath = path.join(
        __dirname,
        '../agent-farm/servers/dashboard-server.ts'
      );
      const content = readFileSync(dashboardServerPath, 'utf-8');

      // These patterns should not exist after removal
      const forbiddenPatterns = [
        'ActivitySummary',
        'collectActivitySummary',
        'getGitCommits',
        'getGitHubPRs',
        'getBuilderActivity',
        'getProjectChanges',
        'calculateTimeTracking',
        'generateAISummary',
      ];

      for (const pattern of forbiddenPatterns) {
        expect(content).not.toContain(pattern);
      }
    });
  });
});
