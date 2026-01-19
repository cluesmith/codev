/**
 * Tests for porch consultation module
 */

import { describe, it, expect } from 'vitest';
import {
  parseVerdict,
  extractSummary,
  hasConsultation,
  getDefaultConsultationConfig,
} from '../consultation.js';

describe('consultation', () => {
  describe('parseVerdict', () => {
    it('should parse explicit APPROVE verdict', () => {
      expect(parseVerdict('Verdict: APPROVE')).toBe('APPROVE');
      expect(parseVerdict('[APPROVE]')).toBe('APPROVE');
    });

    it('should parse explicit REQUEST_CHANGES verdict', () => {
      expect(parseVerdict('Verdict: REQUEST_CHANGES')).toBe('REQUEST_CHANGES');
      expect(parseVerdict('[REQUEST_CHANGES]')).toBe('REQUEST_CHANGES');
    });

    it('should parse implicit approval signals', () => {
      expect(parseVerdict('This looks good to me.')).toBe('APPROVE');
      expect(parseVerdict('The implementation is approved.')).toBe('APPROVE');
    });

    it('should parse implicit change request signals', () => {
      expect(parseVerdict('There is a critical issue that must be fixed.')).toBe('REQUEST_CHANGES');
      expect(parseVerdict('You need to fix the validation logic.')).toBe('REQUEST_CHANGES');
    });

    it('should default to APPROVE when no clear signal', () => {
      expect(parseVerdict('Some neutral feedback about the code.')).toBe('APPROVE');
    });
  });

  describe('extractSummary', () => {
    it('should extract summary section', () => {
      const output = `## Summary

This is a good implementation with minor suggestions.

## Details

More detailed feedback here.`;

      const summary = extractSummary(output);
      expect(summary).toBe('This is a good implementation with minor suggestions.');
    });

    it('should extract verdict section', () => {
      const output = `## Verdict

The code is well-structured and follows best practices.

## Suggestions`;

      const summary = extractSummary(output);
      expect(summary).toBe('The code is well-structured and follows best practices.');
    });

    it('should fall back to first meaningful paragraph', () => {
      const output = `The implementation correctly handles the edge cases and validates input properly. The code structure is clean.`;

      const summary = extractSummary(output, 100);
      expect(summary.length).toBeLessThanOrEqual(100);
      expect(summary).toContain('implementation');
    });

    it('should truncate long summaries', () => {
      const longText = 'A'.repeat(600);
      const summary = extractSummary(longText, 500);
      expect(summary.length).toBe(500);
      expect(summary.endsWith('...')).toBe(true);
    });
  });

  describe('hasConsultation', () => {
    it('should return true when consultation configured', () => {
      expect(hasConsultation({
        consultation: {
          on: 'review',
          models: ['gemini', 'codex'],
          type: 'spec-review',
          next: 'plan',
        },
      })).toBe(true);
    });

    it('should return false when no consultation', () => {
      expect(hasConsultation({})).toBe(false);
      expect(hasConsultation({ consultation: undefined })).toBe(false);
    });

    it('should return false when empty models array', () => {
      expect(hasConsultation({
        consultation: {
          on: 'review',
          models: [],
          type: 'spec-review',
          next: 'plan',
        },
      })).toBe(false);
    });
  });

  describe('getDefaultConsultationConfig', () => {
    it('should return spec-review config', () => {
      const config = getDefaultConsultationConfig('spec-review');
      expect(config.type).toBe('spec-review');
      expect(config.next).toBe('plan');
      expect(config.models).toContain('gemini');
    });

    it('should return plan-review config', () => {
      const config = getDefaultConsultationConfig('plan-review');
      expect(config.type).toBe('plan-review');
      expect(config.next).toBe('implement');
    });

    it('should return impl-review config', () => {
      const config = getDefaultConsultationConfig('impl-review');
      expect(config.type).toBe('impl-review');
      expect(config.max_rounds).toBe(2);
    });

    it('should return generic config for unknown types', () => {
      const config = getDefaultConsultationConfig('custom-review');
      expect(config.type).toBe('custom-review');
      expect(config.models.length).toBe(3);
    });
  });
});
