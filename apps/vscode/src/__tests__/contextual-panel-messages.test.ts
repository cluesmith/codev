/**
 * Unit tests for the host<->webview message validation (Phase 4). webview->host messages are
 * lower-trust, so field values are validated, not just the type.
 */

import { describe, it, expect } from 'vitest';
import { parseNavigation, isReadyMessage } from '../contextual-panel/messages.js';

const known = (id: string): boolean => id === 'b1' || id === 'b2';

describe('parseNavigation', () => {
  it('accepts a valid mode-navigate', () => {
    expect(parseNavigation({ type: 'mode-navigate', mode: 'code-review' }, known)).toEqual({
      type: 'mode-navigate',
      mode: 'code-review',
    });
  });

  it('accepts a drill-in to a known builder', () => {
    expect(parseNavigation({ type: 'drill-in', mode: 'builder-inspector', builderId: 'b1' }, known)).toEqual({
      type: 'drill-in',
      mode: 'builder-inspector',
      builderId: 'b1',
    });
  });

  it('rejects an invalid mode value', () => {
    expect(parseNavigation({ type: 'mode-navigate', mode: 'nope' }, known)).toBeNull();
  });

  it('rejects a drill-in to an unknown builder', () => {
    expect(parseNavigation({ type: 'drill-in', mode: 'code-review', builderId: 'ghost' }, known)).toBeNull();
  });

  it('rejects a drill-in missing its builderId', () => {
    expect(parseNavigation({ type: 'drill-in', mode: 'code-review' }, known)).toBeNull();
  });

  it('rejects unknown types and non-objects', () => {
    expect(parseNavigation({ type: 'other' }, known)).toBeNull();
    expect(parseNavigation(null, known)).toBeNull();
    expect(parseNavigation(42, known)).toBeNull();
    expect(parseNavigation(undefined, known)).toBeNull();
  });
});

describe('isReadyMessage', () => {
  it('accepts ready and rejects everything else', () => {
    expect(isReadyMessage({ type: 'ready' })).toBe(true);
    expect(isReadyMessage({ type: 'mode-navigate' })).toBe(false);
    expect(isReadyMessage(null)).toBe(false);
  });
});
