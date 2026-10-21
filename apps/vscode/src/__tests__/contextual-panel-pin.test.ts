import { describe, it, expect } from 'vitest';
import { pinSurfaceToBuilder } from '../contextual-panel/pin.js';

describe('pinSurfaceToBuilder (#1809)', () => {
  it('keeps every signal that belongs to the own builder', () => {
    const surface = {
      artifact: { resourcePath: '/w/.builders/pir-1809/codev/plans/x.md', builderId: 'pir-1809' },
      builderDiff: { builderId: 'pir-1809' },
      builderTerminal: { builderId: 'builder-pir-1809' },
    };
    expect(pinSurfaceToBuilder(surface, 'pir-1809')).toEqual(surface);
  });

  it("drops a sibling builder's diff and terminal", () => {
    expect(pinSurfaceToBuilder(
      { builderDiff: { builderId: 'spir-1049' }, builderTerminal: { builderId: 'builder-spir-1049' } },
      'pir-1809',
    )).toEqual({});
  });

  it('does not tail-match a different id that merely shares a suffix', () => {
    expect(pinSurfaceToBuilder({ builderTerminal: { builderId: 'builder-pir-18090' } }, 'pir-1809')).toEqual({});
  });

  it('keeps the artifact signal (Document Review carries no queue actions)', () => {
    const artifact = { resourcePath: '/w/codev/specs/y.md' };
    expect(pinSurfaceToBuilder({ artifact }, 'pir-1809')).toEqual({ artifact });
  });
});
