import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import * as React from 'react';
import { CommentComposer } from '../CommentComposer.js';

afterEach(cleanup);

/**
 * Unit tests for the inline comment composer (#1107). Verifies the keystroke contract confirmed at
 * the PIR dev-approval gate: Cmd/Ctrl+Enter submits, plain Enter is a newline (not submit), Esc
 * cancels, empty bodies are no-ops, and the buttons mirror those two actions.
 */
function setup(line = 0) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(React.createElement(CommentComposer, { line, onSubmit, onCancel }));
  const input = screen.getByRole('textbox', { name: /add comment on line/i }) as HTMLTextAreaElement;
  return { onSubmit, onCancel, input };
}

describe('CommentComposer (#1107)', () => {
  it('autofocuses the textarea on mount', () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
  });

  it('labels the textarea with the 1-based line number', () => {
    setup(4); // 0-based 4 → "line 5"
    expect(screen.getByRole('textbox', { name: /add comment on line 5/i })).not.toBeNull();
  });

  it('Cmd+Enter submits the trimmed body', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: '  please clarify  ' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith('please clarify');
  });

  it('Ctrl+Enter submits (non-mac)', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: 'looks good' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith('looks good');
  });

  it('plain Enter does NOT submit (newline in the textarea)', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Esc cancels without submitting', () => {
    const { onSubmit, onCancel, input } = setup();
    fireEvent.change(input, { target: { value: 'discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('empty / whitespace-only submit is a no-op', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Comment button submits; it is disabled while the body is empty', () => {
    const { onSubmit, input } = setup();
    const submit = screen.getByRole('button', { name: /^comment$/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'ship it' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('ship it');
  });

  it('Cancel button cancels', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
