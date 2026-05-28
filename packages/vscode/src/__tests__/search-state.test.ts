/**
 * Issue #891: unit tests for the SearchState filter primitive.
 *
 * The `SearchState` class is pure(-ish) — it only depends on
 * `vscode.EventEmitter`, which the test mocks below. Keeping these tests
 * in vitest (rather than the vscode-test electron harness) means they run
 * in milliseconds and stay green even when the workspace can't activate
 * the extension end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode.EventEmitter so SearchState can be imported in pure-node tests.
// Captures fire() / event subscription / dispose semantics minimally.
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners = new Set<(e: T) => void>();
    readonly event = (listener: (e: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(e: T): void {
      for (const l of this.listeners) {l(e);}
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter };
});

import { SearchState } from '../views/search-state.js';

describe('SearchState', () => {
  let state: SearchState;

  beforeEach(() => {
    state = new SearchState();
  });

  describe('matches', () => {
    it('returns true for empty query against any fields', () => {
      expect(state.matches(['anything'])).toBe(true);
      expect(state.matches([])).toBe(true);
      expect(state.matches([null, undefined])).toBe(true);
    });

    it('returns true for whitespace-only query', () => {
      state.setQuery('   ');
      expect(state.matches(['anything'])).toBe(true);
    });

    it('matches case-insensitive substring across fields', () => {
      state.setQuery('Terminal');
      expect(state.matches(['terminal cleanup'])).toBe(true);
      expect(state.matches(['TERMINAL'])).toBe(true);
      expect(state.matches(['regression', 'terminal'])).toBe(true);
    });

    it('returns false when no field contains the query', () => {
      state.setQuery('xyz');
      expect(state.matches(['terminal', 'backlog', 'vscode'])).toBe(false);
    });

    it('tolerates null / undefined fields', () => {
      state.setQuery('term');
      expect(state.matches([null, undefined, 'terminal'])).toBe(true);
      expect(state.matches([null, undefined])).toBe(false);
    });

    it('matches labels and area-style strings', () => {
      state.setQuery('area/vscode');
      expect(state.matches(['something', 'area/vscode', 'else'])).toBe(true);
    });
  });

  describe('setQuery', () => {
    it('updates query', () => {
      state.setQuery('foo');
      expect(state.query).toBe('foo');
    });

    it('fires onDidChange only when value changes', () => {
      const listener = vi.fn();
      state.onDidChange(listener);
      state.setQuery('foo');
      expect(listener).toHaveBeenCalledTimes(1);
      state.setQuery('foo'); // same value
      expect(listener).toHaveBeenCalledTimes(1);
      state.setQuery('bar');
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('clear', () => {
    it('resets query to empty', () => {
      state.setQuery('foo');
      state.clear();
      expect(state.query).toBe('');
    });

    it('fires onDidChange when query was non-empty', () => {
      const listener = vi.fn();
      state.setQuery('foo');
      state.onDidChange(listener);
      state.clear();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not fire onDidChange when query was already empty', () => {
      const listener = vi.fn();
      state.onDidChange(listener);
      state.clear();
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
