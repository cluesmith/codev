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
  it('keeps the PTY line equal to the textarea across appends, replaces and deletes', () => {
    const mirror = new TextareaMirror();
    let pty = '';
    for (const value of ['u', 'un', 'under ', 'under ciecu', 'under circumstances ', 'under circumstances. ', 'under circ']) {
      const { edit, diverged } = mirror.sync(value);
      pty = applyToLine(pty, edit);
      expect(pty).toBe(value);
      expect(diverged).toBe(false);
    }
  });

  it('a soft backspace after other input still deletes, as stock xterm does', () => {
    const mirror = new TextareaMirror();
    mirror.sync('src/comp');
    // Tab completion (or Esc, an arrow, a hardware key) reached the PTY.
    mirror.afterForeignInput('src/comp');
    expect(mirror.sync('src/com', true)).toEqual({ edit: DEL, diverged: false });
  });

  it('a cut or undo reaching back past other input deletes nothing there, and says it diverged', () => {
    const mirror = new TextareaMirror();
    mirror.sync('src/comp');
    mirror.afterForeignInput('src/comp');
    mirror.sync('src/compx');
    // Only the "x" sent after the Tab can be deleted.
    expect(mirror.sync('src/')).toEqual({ edit: DEL, diverged: true });
  });

  it('a deletion that stays after other input is an ordinary delete', () => {
    const mirror = new TextareaMirror();
    mirror.sync('src/comp');
    mirror.afterForeignInput('src/comp');
    mirror.sync('src/comp --all');
    expect(mirror.sync('src/comp')).toEqual({ edit: DEL.repeat(6), diverged: false });
  });

  it('a replace reaching back past other input does not delete that input, and says it diverged', () => {
    const mirror = new TextareaMirror();
    mirror.sync('src/comp');
    mirror.afterForeignInput('src/comp');
    // Typed after the Tab: replacing only that is an ordinary replace.
    expect(mirror.sync('src/compx')).toEqual({ edit: 'x', diverged: false });
    expect(mirror.sync('src/compy')).toEqual({ edit: `${DEL}y`, diverged: false });
    // Reaching back into "src/comp": only the post-Tab "y" can be deleted.
    expect(mirror.sync('src/camp')).toEqual({ edit: `${DEL}amp`, diverged: true });
    // The mirror follows the textarea from here on.
    expect(mirror.sync('src/camps')).toEqual({ edit: 's', diverged: false });
  });

  it('text that never reached the PTY is never deleted and never resent', () => {
    const mirror = new TextareaMirror();
    // Context menu: xterm put the selection "selected" into the textarea.
    mirror.detach('selected');
    expect(mirror.sync('selected x')).toEqual({ edit: ' x', diverged: false });
    // Typing over the selection deletes only what was sent, then sends the rest.
    expect(mirror.sync('y')).toEqual({ edit: `${DEL.repeat(2)}y`, diverged: false });
    expect(mirror.sync('yes').edit).toBe('es');
    expect(mirror.sync('ye').edit).toBe(DEL);
  });

  it('a soft backspace over a detached selection sends nothing', () => {
    const mirror = new TextareaMirror();
    mirror.detach('selected');
    expect(mirror.sync('')).toEqual({ edit: '', diverged: false });
  });

  it('a paste is accepted as sent, so autocorrecting it replaces it', () => {
    const mirror = new TextareaMirror();
    mirror.accept('teh');
    const { edit, diverged } = mirror.sync('the ');
    expect(applyToLine('teh', edit)).toBe('the ');
    expect(diverged).toBe(false);
  });

  it('starts clean after Enter clears the textarea', () => {
    const mirror = new TextareaMirror();
    mirror.sync('hello');
    mirror.afterForeignInput('');
    expect(mirror.sync('next')).toEqual({ edit: 'next', diverged: false });
  });
});

describe('attachImeInput', () => {
  let container: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let emitted: string[];
  let deliver: boolean;
  let bridge: ImeInputBridge;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    emitted = [];
    deliver = true;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge = attachImeInput(textarea, container, (edit) => {
      emitted.push(edit);
      return deliver;
    });
  });

  afterEach(() => {
    bridge.dispose();
    container.remove();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
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

  /** xterm's paste handler: it emits the text, clears the textarea, and the browser inserts it again. */
  async function xtermPaste(text: string) {
    bridge.noteForeignInput();
    textarea.value = '';
    await Promise.resolve();
    edit(text, 'insertFromPaste');
  }

  it('does not resend the browser\'s own paste insert; xterm sends the paste itself', async () => {
    edit('hi ');
    await xtermPaste('pasted');
    edit('pasted!', 'insertText');
    expect(emitted).toEqual(['hi ', '!']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('autocorrecting pasted text replaces it on the PTY (no tehthe)', async () => {
    await xtermPaste('teh');
    edit('the ', 'insertReplacementText');
    expect(emitted).toEqual([`${DEL.repeat(2)}he `]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a multi-line paste leaves the submitted lines alone', async () => {
    await xtermPaste('ls\nteh');
    edit('ls\nthe ', 'insertReplacementText');
    expect(emitted).toEqual([`${DEL.repeat(2)}he `]);
    edit('', 'deleteContentBackward');
    expect(emitted.at(-1)).toBe(DEL.repeat(4));
  });

  it('a soft backspace after other input deletes at the cursor', async () => {
    edit('src/comp');
    bridge.noteForeignInput(); // a virtual Tab
    await Promise.resolve();
    edit('src/com', 'deleteContentBackward');
    expect(emitted).toEqual(['src/comp', DEL]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a replace reaching back past other input fails loud and deletes nothing it should not', async () => {
    edit('src/comp');
    bridge.noteForeignInput();
    await Promise.resolve();
    edit('src/camp', 'insertReplacementText');
    expect(emitted).toEqual(['src/comp', 'amp']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/cannot be retracted/);
  });

  it('a textarea rewritten outside an input event fails loud and resyncs', () => {
    edit('hello');
    textarea.value = 'unexpected';
    edit('unexpected!', 'insertText');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/textarea changed outside an input event/);
    // The log carries lengths, never the user's command line.
    expect(JSON.stringify(errorSpy.mock.calls[0])).not.toMatch(/hello|unexpected/);
    // Nothing deleted, nothing resent: only the new character goes out.
    expect(emitted).toEqual(['hello', '!']);
  });

  it('xterm clearing the textarea on blur is not a desync', () => {
    edit('hello');
    // xterm's blur listener, registered before the bridge's, clears the textarea.
    textarea.value = '';
    textarea.dispatchEvent(new FocusEvent('blur'));
    edit('n', 'insertText');
    expect(emitted).toEqual(['hello', 'n']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('an edit the closed socket could not take is reported, not resent later', () => {
    deliver = false;
    edit('lost');
    // A reconnect, not a desync: a warning, never the desync alarm.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/edit not delivered.*socket not open/);
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toMatch(/lost/);
    deliver = true;
    edit('lost+');
    expect(emitted).toEqual(['lost', '+']);
  });

  it('cutting sent text deletes it on the PTY', () => {
    edit('git status --short');
    edit('git status', 'deleteByCut');
    expect(emitted.at(-1)).toBe(DEL.repeat(8));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('undo and redo reach the PTY as replaces', () => {
    edit('check afain');
    edit('check again', 'insertReplacementText');
    edit('check afain', 'historyUndo');
    edit('check again', 'historyRedo');
    expect(emitted.slice(1)).toEqual([`${DEL.repeat(4)}gain`, `${DEL.repeat(4)}fain`, `${DEL.repeat(4)}gain`]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('dropped text is sent like typed text', () => {
    edit('cat ');
    edit('cat notes.txt', 'insertFromDrop');
    expect(emitted).toEqual(['cat ', 'notes.txt']);
  });

  it('a cut reaching back past other input fails loud and deletes nothing it should not', async () => {
    edit('src/comp');
    bridge.noteForeignInput(); // a virtual Tab
    await Promise.resolve();
    edit('src/', 'deleteByCut');
    // The Tab's completion sits after "src/comp" on the line; DELs would hit it.
    expect(emitted).toEqual(['src/comp']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/cannot be retracted/);
  });

  it('a long-press backspace after other input deletes at the cursor', async () => {
    edit('git status');
    bridge.noteForeignInput();
    await Promise.resolve();
    edit('git ', 'deleteWordBackward');
    expect(emitted.at(-1)).toBe(DEL.repeat(6));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a swallowed edit is never deleted, and nothing typed before it either', () => {
    edit('ls ');
    edit('ls c', 'insertText');
    // A sticky Cmd turned the "c" into a copy; the PTY never got it.
    bridge.noteSwallowedEdit();
    edit('ls ', 'deleteContentBackward');
    edit('ls x', 'insertText');
    expect(emitted).toEqual(['ls ', 'c', 'x']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a mid-line cut reaching back past other input fails loud', async () => {
    edit('git status --short');
    bridge.noteForeignInput(); // an arrow key
    await Promise.resolve();
    edit('git --short', 'deleteByCut');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/cannot be retracted/);
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
    textarea.dispatchEvent(new FocusEvent('blur'));
    expect(emitted).toEqual([]);
  });
});
