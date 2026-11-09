/**
 * Mobile IME input as replace edits (Issue #1883).
 *
 * xterm.js keeps everything typed since the last Enter in its hidden textarea,
 * and a mobile keyboard edits that text in place: autocomplete, autocorrect
 * and smart punctuation replace characters it already committed. xterm's
 * textarea handlers assume the textarea only grows by appends, so a replace
 * reaches the PTY as a misaligned tail or as the whole textarea resent.
 *
 * On touch devices the dashboard therefore owns IME text. After every textarea
 * edit it sends the minimal change against a mirror of what the PTY already
 * holds, as DELs for the diverging tail followed by the new text. xterm still
 * handles real keys (Enter, Backspace, arrows, a hardware keyboard) and paste.
 */

export const DEL = '\x7f';

function commonPrefixLength(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Bytes that turn `sent`, already at the end of the PTY line, into
 * `committed`: one DEL per code point of `sent` past their common prefix,
 * then the rest of `committed`.
 */
export function reconcileComposition(sent: string, committed: string): string {
  const a = Array.from(sent);
  const b = Array.from(committed);
  const p = commonPrefixLength(a, b);
  return DEL.repeat(a.length - p) + b.slice(p).join('');
}

/**
 * What the PTY holds of the textarea's text. The first `floor` code points of
 * `text` did not reach the PTY from the textarea (they were there before a
 * rebase), so no DEL may reach them: deleting there would hit unrelated input.
 */
export class TextareaMirror {
  private text = '';
  private floor = 0;

  /** The textarea value this mirror last accounted for. */
  get value(): string {
    return this.text;
  }

  /** The edit that brings the PTY in line with the textarea's new `value`. */
  sync(value: string): string {
    const old = Array.from(this.text);
    const next = Array.from(value);
    const p = commonPrefixLength(old, next);
    this.text = value;
    if (p >= this.floor) {
      return reconcileComposition(old.slice(this.floor).join(''), next.slice(this.floor).join(''));
    }
    // The edit reaches into text the PTY never got from us: delete only what
    // we sent, then send everything from the change point on.
    const edit = DEL.repeat(old.length - this.floor) + next.slice(p).join('');
    this.floor = p;
    return edit;
  }

  /**
   * Take `value` as the new baseline, none of it deletable. Used when input
   * reached the PTY some other way, or the textarea was rewritten outside an
   * input event.
   */
  rebase(value: string): void {
    this.text = value;
    this.floor = Array.from(value).length;
  }
}

/** Textarea edits that are not typing; xterm or the browser handles them. */
const NOT_TYPED = /^(insertFrom(Paste|PasteAsQuotation|Drop|Yank)$|deleteBy(Cut|Drag)$|history)/;

export interface ImeInputBridge {
  /** True for a keydown the bridge handles; xterm must not process it. */
  ownsKey(event: KeyboardEvent): boolean;
  /** Input reached the PTY outside the textarea (a key, a paste, a virtual key). */
  noteForeignInput(): void;
  dispose(): void;
}

/**
 * Take IME text input away from xterm's append-only handlers and send each
 * textarea edit through `emit` as a replace. `emit` returns whether the edit
 * reached the PTY.
 */
export function attachImeInput(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  emit: (edit: string) => boolean,
): ImeInputBridge {
  const mirror = new TextareaMirror();
  mirror.rebase(textarea.value);

  const resync = (reason: string, detail: Record<string, unknown>) => {
    console.error(`[Terminal IME #1883] ${reason}; resyncing from the textarea`, detail);
    mirror.rebase(textarea.value);
  };

  // xterm's composition and input handlers sit on the textarea. Stopping these
  // events on the container's capture phase keeps them away from xterm, and
  // leaves the browser's own text insertion untouched.
  const shield = (e: Event) => {
    if (e.target === textarea) e.stopPropagation();
  };

  const onBeforeInput = (e: Event) => {
    if (e.target !== textarea || textarea.value === mirror.value) return;
    resync('textarea changed outside an input event', { expected: mirror.value, actual: textarea.value });
  };

  const onInput = (e: Event) => {
    if (e.target !== textarea) return;
    e.stopPropagation();
    if (NOT_TYPED.test((e as InputEvent).inputType ?? '')) {
      mirror.rebase(textarea.value);
      return;
    }
    const edit = mirror.sync(textarea.value);
    if (edit && !emit(edit)) {
      resync('edit not delivered to the PTY', { edit });
    }
  };

  // xterm's right-click handler puts the selection into the textarea.
  const onContextMenu = () => mirror.rebase(textarea.value);

  // xterm sizes the textarea in its composition handler, which is bypassed
  // now. Blink drops the caret to 0 on commit into a 0×0 textarea, so the
  // keyboard would insert at the start; xterm resizes it on cursor moves.
  if (!textarea.style.width) textarea.style.width = '1px';
  if (!textarea.style.height) textarea.style.height = '1px';

  const shielded = ['compositionstart', 'compositionupdate', 'compositionend'];
  for (const type of shielded) container.addEventListener(type, shield, true);
  container.addEventListener('beforeinput', onBeforeInput, true);
  container.addEventListener('input', onInput, true);
  container.addEventListener('contextmenu', onContextMenu);

  return {
    ownsKey: (event) => event.type === 'keydown' && event.keyCode === 229,
    // Deferred: xterm clears the textarea right after it emits a paste.
    noteForeignInput: () => queueMicrotask(() => mirror.rebase(textarea.value)),
    dispose: () => {
      for (const type of shielded) container.removeEventListener(type, shield, true);
      container.removeEventListener('beforeinput', onBeforeInput, true);
      container.removeEventListener('input', onInput, true);
      container.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
