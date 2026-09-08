import * as React from 'react';

export interface CommentComposerProps {
  /** 0-based source line this composer targets (for the accessible label). */
  line: number;
  /**
   * Invoked with the trimmed, non-empty body when the reviewer submits. `viaKeyboard` reports
   * the modality of the CLOSING action (⌘/Ctrl+Enter vs a Submit click): the canvas restores
   * focus to the block afterwards, and the focus ring should follow platform convention —
   * visible for keyboard flows, quiet for pointer flows. (Browsers treat a textarea as always
   * focus-visible, so without this signal the restoration inherits a ring even for
   * mouse-only reviewers.)
   */
  onSubmit: (text: string, viaKeyboard: boolean) => void;
  /** Invoked when the reviewer cancels (Esc / Cancel button); same modality contract. */
  onCancel: (viaKeyboard: boolean) => void;
  /**
   * Prefill body for editing an existing comment (#1055). When present the composer opens seeded
   * with this text and the submit button reads "Save"; when absent it is the empty add composer.
   */
  initialText?: string;
}

/**
 * Imperative seam for driving the composer from outside it (spec 1401).
 *
 * Submission needs the composer's own draft text, which lives in its state, so a remote
 * `composer-submit` cannot go through the parent's `onSubmit` directly and must not synthesize a
 * click on the button. Cancel is deliberately absent: it needs no text, so the parent closes the
 * composer through its existing cancel path rather than routing back through here.
 */
export interface CommentComposerHandle {
  /** Submit the current draft, exactly as ⌘/Ctrl+Enter does. Empty bodies stay a no-op. */
  submit(): void;
}

/**
 * Inline comment composer (#1107). Replaces the old center-top `showInputBox` Quick Pick: it is
 * rendered in-flow directly below the block being commented on (the host portals it into a
 * placeholder there), so the reviewer types the comment exactly where it will live — the visual
 * anchor is preserved end-to-end.
 *
 * Keystrokes (the UX confirmed at the PIR dev-approval gate):
 *  - **Cmd/Ctrl+Enter** submits (matches the GitHub review-composer convention).
 *  - **Enter** inserts a newline — the body is multi-line-natural (a `<textarea>`, not a one-line
 *    input). Newlines collapse to a single space only at write time (`serializeReviewMarker`), so
 *    the on-disk single-line marker format is unchanged.
 *  - **Esc** cancels.
 *
 * It only signals intent via `onSubmit` / `onCancel`; it never writes a marker itself (the host
 * does that, preserving the package's D6 invariant). An empty / whitespace-only body is a no-op.
 */
export const CommentComposer = React.forwardRef<CommentComposerHandle, CommentComposerProps>(
  function CommentComposer(
    { line, onSubmit, onCancel, initialText }: CommentComposerProps,
    handleRef,
  ): React.ReactElement {
  const isEdit = initialText !== undefined;
  const [text, setText] = React.useState(initialText ?? '');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Autofocus on mount so the reviewer can type immediately after clicking "+" / the pencil.
  // For an edit, place the caret at the end of the seeded text rather than selecting all.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) { return; }
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const submit = (viaKeyboard: boolean): void => {
    const body = text.trim();
    if (!body) { return; } // mirrors the host's old `if (!text) return;` guard
    onSubmit(body, viaKeyboard);
  };

  // A remote submit reports `viaKeyboard: true` so focus restoration keeps its visible ring: the
  // reviewer is driving the canvas deliberately and needs to see where focus landed, which is the
  // same reason the ⌘/Ctrl+Enter path passes true.
  React.useImperativeHandle(handleRef, () => ({ submit: () => submit(true) }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel(true);
    }
    // Plain Enter falls through to the textarea's default (insert a newline).
  };

  const empty = text.trim().length === 0;

  return (
    <div className="codev-canvas-comment-composer">
      <textarea
        ref={textareaRef}
        className="codev-canvas-comment-composer-input"
        // Human-facing line numbers are 1-based; the data model stays 0-based (spec D5).
        aria-label={`${isEdit ? 'Edit' : 'Add'} comment on line ${line + 1}`}
        placeholder="Add a review comment… (⌘/Ctrl+Enter to submit, Esc to cancel)"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="codev-canvas-comment-composer-actions">
        {/* `e.detail === 0` = a click synthesized from keyboard activation (Space/Enter on the
            focused button) — still a keyboard flow for focus-ring purposes. */}
        <button
          type="button"
          className="codev-canvas-comment-composer-cancel"
          onClick={(e) => onCancel(e.detail === 0)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="codev-canvas-comment-composer-submit"
          onClick={(e) => submit(e.detail === 0)}
          disabled={empty}
        >
          {isEdit ? 'Save' : 'Comment'}
        </button>
      </div>
    </div>
  );
  },
);
