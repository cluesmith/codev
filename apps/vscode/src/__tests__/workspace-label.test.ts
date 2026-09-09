/** Unit tests for the Tower workspace label disambiguator. Pure — no vscode mock needed. */

import { describe, it, expect } from 'vitest';
import { disambiguateLabels } from '../views/workspace-label.js';

describe('disambiguateLabels', () => {
  it('leaves a unique basename plain', () => {
    const labels = disambiguateLabels([{ path: '/Users/a/marketmaker', name: 'marketmaker' }]);
    expect(labels.get('/Users/a/marketmaker')).toBe('marketmaker');
  });

  it('disambiguates two colliding basenames by their parent segment (#1565)', () => {
    const labels = disambiguateLabels([
      { path: '/Users/a/cluesmith/codev', name: 'codev' },
      { path: '/Users/a/amrmelsayed/codev', name: 'codev' },
    ]);
    expect(labels.get('/Users/a/cluesmith/codev')).toBe('cluesmith/codev');
    expect(labels.get('/Users/a/amrmelsayed/codev')).toBe('amrmelsayed/codev');
  });

  it('mixes plain and disambiguated labels in one list', () => {
    const labels = disambiguateLabels([
      { path: '/Users/a/cluesmith/codev', name: 'codev' },
      { path: '/Users/a/amrmelsayed/codev', name: 'codev' },
      { path: '/Users/a/dashboard-lab', name: 'dashboard-lab' },
    ]);
    expect(labels.get('/Users/a/dashboard-lab')).toBe('dashboard-lab');
    expect(labels.get('/Users/a/cluesmith/codev')).toBe('cluesmith/codev');
  });

  it('deepens the tail uniformly when the parent segment also collides', () => {
    const labels = disambiguateLabels([
      { path: '/Users/a/work/codev', name: 'codev' },
      { path: '/Users/b/work/codev', name: 'codev' },
    ]);
    // parent "work" collides too, so both extend to 3 segments — and stay aligned.
    expect(labels.get('/Users/a/work/codev')).toBe('a/work/codev');
    expect(labels.get('/Users/b/work/codev')).toBe('b/work/codev');
  });

  it('tolerates Windows-style separators', () => {
    const labels = disambiguateLabels([
      { path: 'C:\\dev\\cluesmith\\codev', name: 'codev' },
      { path: 'C:\\dev\\personal\\codev', name: 'codev' },
    ]);
    expect(labels.get('C:\\dev\\cluesmith\\codev')).toBe('cluesmith/codev');
    expect(labels.get('C:\\dev\\personal\\codev')).toBe('personal/codev');
  });

  it('handles three-way collisions', () => {
    const labels = disambiguateLabels([
      { path: '/x/one/codev', name: 'codev' },
      { path: '/x/two/codev', name: 'codev' },
      { path: '/x/three/codev', name: 'codev' },
    ]);
    expect(labels.get('/x/one/codev')).toBe('one/codev');
    expect(labels.get('/x/two/codev')).toBe('two/codev');
    expect(labels.get('/x/three/codev')).toBe('three/codev');
  });
});
