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

export interface SyncResult {
  /** Bytes to send to the PTY. */
  edit: string;
  /**
   * The keyboard replaced text that reached the PTY before some other input.
   * That text cannot be retracted, so the PTY line no longer matches.
   */
  diverged: boolean;
}

/**
 * What the PTY holds of the textarea's text, counted in code points.
 *
 * - Below `replaceFloor`, other input reached the PTY after the text (a key,
 *   a virtual key, a paste). A replace cannot reach back past it, because its
 *   DELs would hit that input instead. Only a backspace still deletes there:
 *   the user is deleting what the line shows at the cursor, as stock xterm
 *   does. A cut or undo of hidden textarea text cannot, and fails loud.
 * - Below `deleteFloor`, the text never reached the PTY at all, for example
 *   the selection xterm puts in the textarea for the context menu. Nothing
 *   may DEL it.
 *
 * Invariant: `deleteFloor <= replaceFloor <= length of text`.
 */
export class TextareaMirror {
  private text = '';
  private replaceFloor = 0;
  private deleteFloor = 0;

  /** The textarea value this mirror last accounted for. */
  get value(): string {
    return this.text;
  }

  /**
   * The edit that brings the PTY in line with the textarea's new `value`.
   * `backspace` marks a deletion the user made at the cursor (the keyboard's
   * backspace key) rather than a cut, drag or undo.
   */
  sync(value: string, backspace = false): SyncResult {
    const old = Array.from(this.text);
    const next = Array.from(value);
    const p = commonPrefixLength(old, next);
    let edit: string;
    let diverged = false;
    if (backspace && p === next.length) {
      // The backspace key. One DEL per code point, where stock xterm sends a
      // single DEL whatever the size of the deletion.
      edit = DEL.repeat(old.length - Math.max(p, this.deleteFloor));
    } else if (p >= this.replaceFloor) {
      edit = reconcileComposition(old.slice(p).join(''), next.slice(p).join(''));
    } else {
      // A replace reaching back past other input: delete only what was sent
      // since that input, then send everything from the change point on.
      edit = DEL.repeat(old.length - this.replaceFloor) + next.slice(p).join('');
      // Text that reached the PTY before that input stays there.
      diverged = this.deleteFloor < this.replaceFloor;
    }
    this.text = value;
    this.replaceFloor = Math.min(this.replaceFloor, p);
    this.deleteFloor = Math.min(this.deleteFloor, p);
    return { edit, diverged };
  }

  /** The PTY received other input after the textarea's current text. */
  afterForeignInput(value: string): void {
    this.deleteFloor = Math.min(this.deleteFloor, commonPrefixLength(Array.from(this.text), Array.from(value)));
    this.text = value;
    this.replaceFloor = Array.from(value).length;
  }

  /**
   * The PTY already holds `value`: xterm sent it as a paste and cleared the
   * textarea, then the browser inserted it again. Text up to its last line
   * break was submitted with it, so only the last line is editable.
   */
  accept(value: string): void {
    const chars = Array.from(value);
    let lineStart = chars.length;
    while (lineStart > 0 && chars[lineStart - 1] !== '\n' && chars[lineStart - 1] !== '\r') lineStart--;
    this.text = value;
    this.replaceFloor = this.deleteFloor = lineStart;
  }

  /** The textarea now holds `value`, none of which reached the PTY. */
  detach(value: string): void {
    this.text = value;
    this.replaceFloor = this.deleteFloor = Array.from(value).length;
  }
}


export interface ImeInputBridge {
  /** True for a keydown the bridge handles; xterm must not process it. */
  ownsKey(event: KeyboardEvent): boolean;
  /** Input reached the PTY outside the textarea (a key, a paste, a virtual key). */
  noteForeignInput(): void;
  /**
   * The bridge's last edit never reached the PTY as itself: a sticky modifier
   * swallowed it, or turned it into a control character.
   */
  noteSwallowedEdit(): void;
  dispose(): void;
}

/** The keyboard's backspace key, as the browser reports it. */
const BACKSPACE = /^delete(Content|Word|SoftLine|HardLine)Backward$/;

/**
 * Take IME text input away from xterm's append-only handlers and send each
 * textarea edit through `emit` as a replace. `emit` returns whether the edit
 * reached the PTY.
 *
 * Every edit is synced: typing and autocomplete, and also cut, drag, drop,
 * yank and undo/redo, which stock xterm never sent at all. The one exception
 * is a paste, which xterm sends itself.
 */
export function attachImeInput(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  emit: (edit: string) => boolean,
): ImeInputBridge {
  const mirror = new TextareaMirror();
  mirror.detach(textarea.value);

  // Lengths only: the textarea holds the user's command line.
  const alarm = (reason: string, detail: Record<string, number>) => {
    console.error(`[Terminal IME #1883] ${reason}; resyncing from the textarea`, detail);
  };
  // Not a desync: the socket is closed, as it is during a reconnect.
  const notDelivered = (detail: Record<string, number>) => {
    console.warn('[Terminal IME #1883] edit not delivered to the PTY (socket not open); resyncing from the textarea', detail);
  };

  // xterm's composition and input handlers sit on the textarea. Stopping these
  // events on the container's capture phase keeps them away from xterm, and
  // leaves the browser's own text insertion untouched.
  const shield = (e: Event) => {
    if (e.target === textarea) e.stopPropagation();
  };

  const onBeforeInput = (e: Event) => {
    if (e.target !== textarea || textarea.value === mirror.value) return;
    alarm('textarea changed outside an input event', {
      expectedLength: mirror.value.length,
      actualLength: textarea.value.length,
    });
    mirror.detach(textarea.value);
  };

  const onInput = (e: Event) => {
    if (e.target !== textarea) return;
    e.stopPropagation();
    const inputType = (e as InputEvent).inputType ?? '';
    if (inputType.startsWith('insertFromPaste')) {
      // The browser's own paste after xterm's: xterm already sent this text.
      mirror.accept(textarea.value);
      return;
    }
    const { edit, diverged } = mirror.sync(textarea.value, BACKSPACE.test(inputType));
    if (diverged) {
      alarm('an edit replaced text sent before other terminal input, which cannot be retracted', {
        textareaLength: textarea.value.length,
      });
    }
    if (edit && !emit(edit)) {
      notDelivered({ editLength: edit.length });
      mirror.detach(textarea.value);
    }
  };

  // xterm's right-click handler puts the selection into the textarea.
  const onContextMenu = () => mirror.detach(textarea.value);
  // xterm clears the textarea on blur. Registered after xterm's listener, so
  // this runs after the clear.
  const onBlur = () => mirror.detach(textarea.value);

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
  textarea.addEventListener('blur', onBlur);

  return {
    ownsKey: (event) => event.type === 'keydown' && event.keyCode === 229,
    // Deferred: xterm clears the textarea right after it emits a paste.
    noteForeignInput: () => queueMicrotask(() => mirror.afterForeignInput(textarea.value)),
    // What the line holds after a control character is unknown, so nothing
    // typed before it may be deleted or replaced.
    noteSwallowedEdit: () => mirror.detach(textarea.value),
    dispose: () => {
      for (const type of shielded) container.removeEventListener(type, shield, true);
      container.removeEventListener('beforeinput', onBeforeInput, true);
      container.removeEventListener('input', onInput, true);
      container.removeEventListener('contextmenu', onContextMenu);
      textarea.removeEventListener('blur', onBlur);
    },
  };
}
