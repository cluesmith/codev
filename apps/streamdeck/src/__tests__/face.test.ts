import { describe, it, expect } from 'vitest';
import type { OverviewBuilder } from '@cluesmith/codev-sdk/controller';
import { builderState, stateLabel, faceForBuilder, builderFaceSvg, gatesFaceSvg, labelFaceSvg, svgToDataUri } from '../face.js';

/** Minimal builder fixture — only the fields the face reads matter; the rest are filler. */
function builder(over: Partial<OverviewBuilder>): OverviewBuilder {
  return {
    id: 'pir-x',
    issueId: null,
    blocked: null,
    blockedGate: null,
    protocolPhase: '',
    ...over,
  } as OverviewBuilder;
}

describe('builderState', () => {
  it('is blocked when a gate is pending (blockedGate or the blocked label)', () => {
    expect(builderState(builder({ blockedGate: 'plan-approval' }))).toBe('blocked');
    expect(builderState(builder({ blocked: 'plan review' }))).toBe('blocked');
  });
  it('is active otherwise (waiting is the deferred follow-up)', () => {
    expect(builderState(builder({ protocolPhase: 'implement' }))).toBe('active');
    expect(builderState(builder({}))).toBe('active');
  });
});

describe('stateLabel', () => {
  it('maps every gate id to its short label, gate beating phase', () => {
    expect(stateLabel(builder({ blockedGate: 'spec-approval' }))).toBe('Spec');
    expect(stateLabel(builder({ blockedGate: 'plan-approval', protocolPhase: 'plan' }))).toBe('Plan');
    expect(stateLabel(builder({ blockedGate: 'dev-approval' }))).toBe('Dev');
    expect(stateLabel(builder({ blockedGate: 'pr' }))).toBe('PR');
    expect(stateLabel(builder({ blockedGate: 'verify-approval' }))).toBe('Verify');
  });
  it('maps every phase id, with verify (in-progress) distinct from verified/complete (terminal)', () => {
    expect(stateLabel(builder({ protocolPhase: 'specify' }))).toBe('Specify');
    expect(stateLabel(builder({ protocolPhase: 'plan' }))).toBe('Plan');
    expect(stateLabel(builder({ protocolPhase: 'implement' }))).toBe('Implement');
    expect(stateLabel(builder({ protocolPhase: 'review' }))).toBe('Review');
    expect(stateLabel(builder({ protocolPhase: 'verify' }))).toBe('Verify');
    expect(stateLabel(builder({ protocolPhase: 'verified' }))).toBe('Verified');
    expect(stateLabel(builder({ protocolPhase: 'complete' }))).toBe('Verified');
    expect(stateLabel(builder({ protocolPhase: 'pr' }))).toBe('PR');
  });
  it('title-cases an unmapped id and returns empty for no state', () => {
    expect(stateLabel(builder({ protocolPhase: 'rebase' }))).toBe('Rebase');
    expect(stateLabel(builder({}))).toBe('');
  });
  it('an unmapped gate STILL wins over a known phase — a pending gate is never masked', () => {
    // Regression for the review consultation (Codex): previously a mapped phase (`review`) beat an
    // unmapped gate, so a builder blocked at a future gate showed its phase while the face was
    // yellow + bell. Any gate now wins, title-cased to its first token.
    expect(stateLabel(builder({ blockedGate: 'security-approval', protocolPhase: 'review' }))).toBe('Security');
  });
});

describe('faceForBuilder', () => {
  it('picks the gate-specific glyph when blocked', () => {
    expect(faceForBuilder(builder({ blockedGate: 'plan-approval' })).icon).toBe('checklist');
    expect(faceForBuilder(builder({ blockedGate: 'dev-approval' })).icon).toBe('code');
    expect(faceForBuilder(builder({ blockedGate: 'pr' })).icon).toBe('pull-request');
    expect(faceForBuilder(builder({ blockedGate: 'spec-approval' })).icon).toBe('book');
    expect(faceForBuilder(builder({ blockedGate: 'verify-approval' })).icon).toBe('verified');
  });
  it('falls back to bell for a blocked-but-unmapped gate', () => {
    expect(faceForBuilder(builder({ blocked: 'huh', blockedGate: 'future-gate' })).icon).toBe('bell');
  });
  it('uses the bolt when active', () => {
    expect(faceForBuilder(builder({ protocolPhase: 'implement' })).icon).toBe('bolt');
  });
  it('prefers the issue number, falling back to the builder id', () => {
    expect(faceForBuilder(builder({ issueId: '101' })).number).toBe('#101');
    expect(faceForBuilder(builder({ id: 'pir-7', issueId: null })).number).toBe('pir-7');
  });
});

describe('builderFaceSvg', () => {
  it('renders a blocked face: number, mapped label, and warning-yellow glyph', () => {
    const svg = builderFaceSvg(faceForBuilder(builder({ issueId: '1425', blockedGate: 'plan-approval' })));
    expect(svg).toContain('#1425');
    expect(svg).toContain('>Plan<');
    expect(svg).toContain('#cca700');
    expect(svg.startsWith('<svg')).toBe(true);
  });
  it('renders an active face in green', () => {
    const svg = builderFaceSvg(faceForBuilder(builder({ issueId: '1414', protocolPhase: 'implement' })));
    expect(svg).toContain('>Implement<');
    expect(svg).toContain('#73c991');
  });
  it('renders the empty-slot face with the slot label and no number', () => {
    const svg = builderFaceSvg({ kind: 'empty', slot: '6' });
    expect(svg).toContain('Slot 6');
    expect(svg).not.toContain('#cca700');
  });
  it('escapes XML so an id with special characters cannot break the SVG', () => {
    const svg = builderFaceSvg(faceForBuilder(builder({ id: 'a<b&c', issueId: null })));
    expect(svg).toContain('a&lt;b&amp;c');
  });
  it('carries an intrinsic width/height so Stream Deck does not drop the image', () => {
    const svg = builderFaceSvg({ kind: 'empty', slot: '1' });
    expect(svg).toContain('width="72"');
    expect(svg).toContain('height="72"');
  });
  it('shrinks a long primary datum to fit (no clip) but leaves a short number natural', () => {
    const longId = builderFaceSvg(faceForBuilder(builder({ id: 'builder-pir-1428', issueId: null })));
    expect(longId).toContain('lengthAdjust="spacingAndGlyphs"');
    const shortNum = builderFaceSvg(faceForBuilder(builder({ issueId: '1414', protocolPhase: 'implement' })));
    expect(shortNum).not.toContain('lengthAdjust');
  });
});

describe('gatesFaceSvg', () => {
  it('shows the pending count + "Gates" in warning yellow when gates await approval', () => {
    const svg = gatesFaceSvg(3);
    expect(svg).toContain('>3<');
    expect(svg).toContain('Gates');
    expect(svg).toContain('#cca700');
  });
  it('shows just "Gates" (dim, no count) when none are pending', () => {
    const svg = gatesFaceSvg(0);
    expect(svg).toContain('Gates');
    expect(svg).not.toContain('#cca700');
  });
});

describe('labelFaceSvg', () => {
  it('renders an icon over a single centered label (the Run Dev pattern)', () => {
    const svg = labelFaceSvg('play', 'Dev', '#73c991');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Dev');
    expect(svg).toContain('#73c991');
    expect(svg).toContain('M8 5v14l11-7z'); // the play glyph
    expect(svg).toContain('width="72"');
  });
});

describe('svgToDataUri', () => {
  it('wraps an SVG as a base64 svg+xml data URI that decodes back to the source', () => {
    const svg = builderFaceSvg(faceForBuilder(builder({ issueId: '1414', protocolPhase: 'implement' })));
    const uri = svgToDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(decoded).toBe(svg);
  });
});
