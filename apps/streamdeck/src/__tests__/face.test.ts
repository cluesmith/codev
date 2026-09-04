import { describe, it, expect } from 'vitest';
import type { OverviewBuilder } from '@cluesmith/codev-sdk/controller';
import { builderState, stateLabel, faceForBuilder, builderFaceSvg, approveFaceSvg, sendFbFaceSvg, labelFaceSvg, architectFaceSvg, architectKeyFaceSvg, capitalizeFirst, svgToDataUri } from '../face.js';

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

describe('approveFaceSvg (#1410)', () => {
  it('shows the selected builder’s gate label over an Approve band, warning-tinted, when blocked', () => {
    const svg = approveFaceSvg({ blockedGate: 'plan-approval' });
    expect(svg).toContain('Plan');
    expect(svg).toContain('Approve');
    expect(svg).toContain('#cca700');
  });
  it('is dim + inert (just "Approve") when the selected builder is not blocked / none selected', () => {
    expect(approveFaceSvg({ blockedGate: null })).toContain('Approve');
    expect(approveFaceSvg({ blockedGate: null })).not.toContain('#cca700');
    expect(approveFaceSvg(undefined)).toContain('Approve');
  });
});

describe('sendFbFaceSvg (#1410)', () => {
  it('shows the queued count + "Send Fb" in active green when there is feedback to send', () => {
    const svg = sendFbFaceSvg(4);
    expect(svg).toContain('>4<');
    expect(svg).toContain('Send Fb');
    expect(svg).toContain('#73c991'); // active green
  });
  it('is dim + inert (just "Send Fb", no count) when nothing is queued', () => {
    const svg = sendFbFaceSvg(0);
    expect(svg).toContain('Send Fb');
    expect(svg).not.toContain('#73c991');
  });
});

describe('builder face selection accent (#1410)', () => {
  it('draws an accent ring only when the slot holds the selection', () => {
    const selected = builderFaceSvg(faceForBuilder(builder({ issueId: '1' }), true));
    const plain = builderFaceSvg(faceForBuilder(builder({ issueId: '1' }), false));
    expect(selected).toContain('stroke-width="3"');
    expect(plain).not.toContain('stroke-width="3"');
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

describe('capitalizeFirst', () => {
  it('capitalizes only the first letter of a lowercase wire name', () => {
    expect(capitalizeFirst('main')).toBe('Main');
    expect(capitalizeFirst('streamdeck')).toBe('Streamdeck');
    expect(capitalizeFirst('ob-refine')).toBe('Ob-refine');
    expect(capitalizeFirst('architect-2')).toBe('Architect-2');
    expect(capitalizeFirst('')).toBe('');
  });
});

describe('architectFaceSvg (#1463)', () => {
  it('renders the constant "Architect" title over the resolved name, capitalized', () => {
    const main = architectFaceSvg('main');
    expect(main).toContain('Architect');
    expect(main).toContain('Main');
    expect(main).toContain('#a9a9b2'); // active (not dimmed)
    expect(main).not.toContain('None');

    const sibling = architectFaceSvg('streamdeck');
    expect(sibling).toContain('Streamdeck');
  });
  it('is dim + inert ("Architect" over "None") when no architect resolves', () => {
    const inert = architectFaceSvg(undefined);
    expect(inert).toContain('Architect');
    expect(inert).toContain('None');
    expect(inert).toContain('#63636b'); // dimmed
  });
  it('shrink-fits a long name so it does not overflow the face', () => {
    // The constant "Architect" title always shrink-fits, so a long NAME must add a
    // second lengthAdjust beyond the short-name baseline.
    const count = (s: string): number => (s.match(/lengthAdjust/g) ?? []).length;
    expect(count(architectFaceSvg('streamdeck'))).toBeGreaterThan(count(architectFaceSvg('main')));
  });
  it('is a valid self-contained SVG', () => {
    expect(architectFaceSvg('main').startsWith('<svg')).toBe(true);
    expect(architectFaceSvg('main')).toContain('width="72"');
  });
});

describe('architectKeyFaceSvg (#1495)', () => {
  it('shows the capitalized architect name as the prominent line', () => {
    const face = architectKeyFaceSvg('streamdeck');
    expect(face).toContain('Streamdeck');
    expect(face).toContain('M5.5 20a6.5 6.5 0 0 1 13 0'); // architect (person) glyph
  });
  it('renders a dim, inert "No architect" face for an empty slot — never blank-but-live', () => {
    const empty = architectKeyFaceSvg(undefined);
    expect(empty).toContain('No architect');
    expect(empty).toContain('#63636b'); // the dim/inert tint
    expect(empty).not.toContain('#f4f4f6'); // never the bright name tint
  });
  it('shrink-fits a long name so it cannot clip the 72px face', () => {
    expect(architectKeyFaceSvg('streamdeck')).toContain('lengthAdjust');
    expect(architectKeyFaceSvg('main')).not.toContain('lengthAdjust');
  });
  it('is a valid self-contained SVG', () => {
    expect(architectKeyFaceSvg('main').startsWith('<svg')).toBe(true);
    expect(architectKeyFaceSvg('main')).toContain('width="72"');
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
