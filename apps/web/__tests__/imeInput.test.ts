/**
 * Issue #1883: a mobile keyboard's autocomplete replaces text it already
 * committed, and that must reach the PTY as a replace (DELs, then the new
 * text), never as an append of a fragment or of the whole textarea.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEL, reconcileComposition, TextareaMirror, attachImeInput, type ImeInputBridge } from '../src/lib/imeInput.js';

/** What a line editor shows after receiving `bytes`: DEL removes one code point. */
function applyToLine(line: string, bytes: string): string {
  const chars = Array.from(line);
  for (const ch of Array.from(bytes)) {
    if (ch === DEL) chars.pop();
    else chars.push(ch);
  }
  return chars.join('');
}

describe('reconcileComposition', () => {
  // The three samples from the issue, decomposed into what had already
  // reached the PTY and what the keyboard committed in its place.
  it.each([
    ['sample 1: autocomplete afain → again', 'check afain', 'check again', `${DEL.repeat(4)}gain`],
    ['sample 2: autocomplete ciecu → circumstances',
      'makes no sense. under normal ciecu', 'makes no sense. under normal circumstances ', `${DEL.repeat(3)}rcumstances `],
    ['sample 3: smart punctuation replaces the trailing space',
      'what have you done since we last spoke ', 'what have you done since we last spoke. ', `${DEL}. `],
  ])('%s', (_name, sent, committed, expected) => {
    const edit = reconcileComposition(sent, committed);
    expect(edit).toBe(expected);
    expect(applyToLine(sent, edit)).toBe(committed);
  });

  it.each([
    ['plain append', 'hello', 'hello world', ' world'],
    ['replace of the last word', 'the quick brwn', 'the quick brown', `${DEL.repeat(2)}own`],
    ['replace mid-sentence retypes from the change point', 'teh quick fox', 'the quick fox', `${DEL.repeat(12)}he quick fox`],
    ['whole-value re-emit sends only the suffix', 'since we last spoke', 'since we last spoke again', ' again'],
    ['identical text sends nothing', 'same', 'same', ''],
    ['empty commit deletes what was sent', 'abc', '', DEL.repeat(3)],
    ['empty to empty', '', '', ''],
    ['emoji counts as one character', 'ok 👋', 'ok 👍', `${DEL}👍`],
  ])('%s', (_name, sent, committed, expected) => {
    const edit = reconcileComposition(sent, committed);
    expect(edit).toBe(expected);
    expect(applyToLine(sent, edit)).toBe(committed);
  });
});

describe('TextareaMirror', () => {
  it('keeps the PTY line equal to the textarea across appends and replaces', () => {
    const mirror = new TextareaMirror();
    let pty = '';
    for (const value of ['u', 'un', 'under ', 'under ciecu', 'under circumstances ', 'under circumstances. ']) {
      pty = applyToLine(pty, mirror.sync(value));
      expect(pty).toBe(value);
    }
  });

  it('after a rebase, never deletes text the PTY did not get from the textarea', () => {
    const mirror = new TextareaMirror();
    // Context menu: xterm put the selection "selected" into the textarea.
    mirror.rebase('selected');
    // Appending sends only the new text.
    expect(mirror.sync('selected x')).toBe(' x');
    // Typing over the selection deletes only what we sent, then sends the rest.
    expect(mirror.sync('y')).toBe(`${DEL.repeat(2)}y`);
    // The baseline is gone now, so later edits are ordinary replaces.
    expect(mirror.sync('yes')).toBe('es');
    expect(mirror.sync('ye')).toBe(DEL);
  });

  it('rebases to an empty textarea after Enter clears it', () => {
    const mirror = new TextareaMirror();
    mirror.sync('hello');
    mirror.rebase('');
    expect(mirror.sync('next')).toBe('next');
  });
});

describe('attachImeInput', () => {
  let container: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let emitted: string[];
  let deliver: boolean;
  let bridge: ImeInputBridge;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    emitted = [];
    deliver = true;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge = attachImeInput(textarea, container, (edit) => {
      emitted.push(edit);
      return deliver;
    });
  });

  afterEach(() => {
    bridge.dispose();
    container.remove();
    errorSpy.mockRestore();
  });

  /** The keyboard changes the textarea, the way the browser reports it. */
  function edit(value: string, inputType = 'insertCompositionText') {
    textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }));
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  }

  it('sends each edit as a replace against what was already sent', () => {
    edit('c');
    edit('ci');
    edit('ciecu');
    edit('circumstances', 'insertReplacementText');
    expect(emitted).toEqual(['c', 'i', 'ecu', `${DEL.repeat(3)}rcumstances`]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps composition and input events away from xterm on the textarea', () => {
    const xtermListener = vi.fn();
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
      textarea.addEventListener(type, xtermListener);
    }
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'a' }));
    edit('a');
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'a' }));
    expect(xtermListener).not.toHaveBeenCalled();
  });

  it('owns keydown 229 (IME processing) and nothing else', () => {
    expect(bridge.ownsKey(new KeyboardEvent('keydown', { keyCode: 229 }))).toBe(true);
    expect(bridge.ownsKey(new KeyboardEvent('keyup', { keyCode: 229 }))).toBe(false);
    expect(bridge.ownsKey(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }))).toBe(false);
    expect(bridge.ownsKey(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8 }))).toBe(false);
  });

  it('does not send a native paste insert; xterm sends the paste itself', () => {
    edit('hi ');
    edit('hi pasted', 'insertFromPaste');
    edit('hi pasted!', 'insertText');
    expect(emitted).toEqual(['hi ', '!']);
  });

  it('a textarea rewritten outside an input event fails loud and resyncs', () => {
    edit('hello');
    textarea.value = 'unexpected';
    edit('unexpected!', 'insertText');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/textarea changed outside an input event/);
    // Nothing deleted, nothing resent: only the new character goes out.
    expect(emitted).toEqual(['hello', '!']);
  });

  it('an undelivered edit fails loud and is not resent later', () => {
    deliver = false;
    edit('lost');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/edit not delivered/);
    deliver = true;
    edit('lost+');
    expect(emitted).toEqual(['lost', '+']);
  });

  it('foreign input rebases once xterm has cleared the textarea', async () => {
    edit('hello');
    // Enter: xterm clears the textarea, then emits \r.
    textarea.value = '';
    bridge.noteForeignInput();
    await Promise.resolve();
    edit('n', 'insertText');
    expect(emitted).toEqual(['hello', 'n']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('the context-menu selection xterm puts in the textarea is never sent', () => {
    edit('typed ');
    textarea.value = 'word';
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    edit('x', 'insertText');
    expect(emitted).toEqual(['typed ', 'x']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('stops listening on dispose', () => {
    bridge.dispose();
    edit('a', 'insertText');
    expect(emitted).toEqual([]);
  });
});
