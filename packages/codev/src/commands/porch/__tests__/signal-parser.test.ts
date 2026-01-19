/**
 * Tests for porch signal parser
 */

import { describe, it, expect } from 'vitest';
import {
  extractSignal,
  extractAllSignals,
  hasSignal,
  stripSignals,
  formatSignal,
  CommonSignals,
} from '../signal-parser.js';

describe('signal-parser', () => {
  describe('extractSignal', () => {
    it('should extract signal from text', () => {
      const text = 'Some output text\n<signal>PHASE_COMPLETE</signal>\nMore text';
      const result = extractSignal(text);
      expect(result).toBe('PHASE_COMPLETE');
    });

    it('should extract signal with value', () => {
      const text = '<signal>BLOCKED:Missing dependency</signal>';
      const result = extractSignal(text);
      expect(result).toBe('BLOCKED:Missing dependency');
    });

    it('should return null when no signal present', () => {
      const text = 'Just some regular output without any signals';
      const result = extractSignal(text);
      expect(result).toBeNull();
    });

    it('should extract last signal when multiple present', () => {
      const text = '<signal>FIRST</signal>\n<signal>SECOND</signal>';
      const result = extractSignal(text);
      // The implementation returns the LAST signal
      expect(result).toBe('SECOND');
    });
  });

  describe('extractAllSignals', () => {
    it('should extract all signals', () => {
      const text = '<signal>FIRST</signal>\n<signal>SECOND</signal>\n<signal>THIRD</signal>';
      const result = extractAllSignals(text);
      expect(result).toEqual(['FIRST', 'SECOND', 'THIRD']);
    });

    it('should return empty array when no signals', () => {
      const result = extractAllSignals('No signals here');
      expect(result).toEqual([]);
    });
  });

  describe('hasSignal', () => {
    it('should return true when signal present', () => {
      expect(hasSignal('<signal>TEST</signal>')).toBe(true);
    });

    it('should return false when no signal', () => {
      expect(hasSignal('No signal here')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(hasSignal('<SIGNAL>TEST</SIGNAL>')).toBe(true);
      expect(hasSignal('<Signal>test</Signal>')).toBe(true);
    });
  });

  describe('stripSignals', () => {
    it('should remove all signals from text', () => {
      const text = 'Before <signal>TEST</signal> After <signal>OTHER</signal> End';
      const result = stripSignals(text);
      expect(result).toBe('Before  After  End');
    });

    it('should return trimmed text', () => {
      const text = '  <signal>TEST</signal>  ';
      const result = stripSignals(text);
      expect(result).toBe('');
    });
  });

  describe('formatSignal', () => {
    it('should format signal correctly', () => {
      expect(formatSignal('PHASE_COMPLETE')).toBe('<signal>PHASE_COMPLETE</signal>');
      expect(formatSignal('BLOCKED:reason')).toBe('<signal>BLOCKED:reason</signal>');
    });
  });

  describe('CommonSignals', () => {
    it('should have expected signals', () => {
      expect(CommonSignals.PHASE_COMPLETE).toBe('PHASE_COMPLETE');
      expect(CommonSignals.BLOCKED).toBe('BLOCKED');
      expect(CommonSignals.SPEC_DRAFTED).toBe('SPEC_DRAFTED');
      expect(CommonSignals.TESTS_PASSING).toBe('TESTS_PASSING');
    });
  });
});
