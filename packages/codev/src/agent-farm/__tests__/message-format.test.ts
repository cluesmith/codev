/**
 * Tests for message formatting utilities (utils/message-format.ts)
 * Spec 0110: Messaging Infrastructure — Phase 2
 */

import { describe, it, expect } from 'vitest';
import { formatArchitectMessage, formatBuilderMessage } from '../utils/message-format.js';

describe('formatArchitectMessage', () => {
  it('wraps message in structured header/footer', () => {
    const result = formatArchitectMessage('Hello builder');
    expect(result).toMatch(/^### \[ARCHITECT INSTRUCTION \|/);
    expect(result).toContain('Hello builder');
    expect(result).toMatch(/###############################$/);
  });

  it('appends file content when provided', () => {
    const result = formatArchitectMessage('Review this', 'file contents here');
    expect(result).toContain('Attached content:');
    expect(result).toContain('file contents here');
  });

  it('returns raw message without wrapping when raw=true', () => {
    const result = formatArchitectMessage('Hello builder', undefined, true);
    expect(result).toBe('Hello builder');
    expect(result).not.toContain('ARCHITECT INSTRUCTION');
  });

  it('returns raw message with file content when raw=true', () => {
    const result = formatArchitectMessage('Hello', 'file data', true);
    expect(result).toContain('Hello');
    expect(result).toContain('file data');
    expect(result).not.toContain('ARCHITECT INSTRUCTION');
  });

  it('includes ISO timestamp in header', () => {
    const result = formatArchitectMessage('test');
    // Match ISO timestamp pattern
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('formatBuilderMessage', () => {
  it('wraps message in structured header/footer with builder ID', () => {
    const result = formatBuilderMessage('builder-spir-109', 'Status update');
    expect(result).toMatch(/^### \[BUILDER builder-spir-109 MESSAGE \|/);
    expect(result).toContain('Status update');
    expect(result).toMatch(/###############################$/);
  });

  it('appends file content when provided', () => {
    const result = formatBuilderMessage('builder-spir-109', 'Review', 'code here');
    expect(result).toContain('Attached content:');
    expect(result).toContain('code here');
  });

  it('returns raw message without wrapping when raw=true', () => {
    const result = formatBuilderMessage('builder-spir-109', 'Hello architect', undefined, true);
    expect(result).toBe('Hello architect');
    expect(result).not.toContain('BUILDER');
  });

  it('returns raw message with file content when raw=true', () => {
    const result = formatBuilderMessage('builder-spir-109', 'Hello', 'data', true);
    expect(result).toContain('Hello');
    expect(result).toContain('data');
    expect(result).not.toContain('BUILDER');
  });

  it('includes the builder ID in the header', () => {
    const result = formatBuilderMessage('builder-bugfix-42', 'test');
    expect(result).toContain('BUILDER builder-bugfix-42 MESSAGE');
  });
});
