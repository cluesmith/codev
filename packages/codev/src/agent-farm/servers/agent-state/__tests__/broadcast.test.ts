/**
 * Spec 1595: agent-state changes coalesce into one `overview-changed` per
 * workspace per window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coalesceAgentStateChanges, AGENT_STATE_BROADCAST_DELAY_MS } from '../broadcast.js';

describe('coalesceAgentStateChanges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst into one trailing notification per workspace', () => {
    const notify = vi.fn();
    const onChange = coalesceAgentStateChanges(notify);

    onChange({ workspacePath: '/a', agentId: 'builder-spir-1' });
    onChange({ workspacePath: '/a', agentId: 'builder-spir-2' });
    onChange({ workspacePath: '/b', agentId: 'main' });
    expect(notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AGENT_STATE_BROADCAST_DELAY_MS);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('/a');
    expect(notify).toHaveBeenCalledWith('/b');
  });

  it('notifies again for a change after the window closed', () => {
    const notify = vi.fn();
    const onChange = coalesceAgentStateChanges(notify, 100);

    onChange({ workspacePath: '/a', agentId: 'main' });
    vi.advanceTimersByTime(100);
    onChange({ workspacePath: '/a', agentId: 'main' });
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
