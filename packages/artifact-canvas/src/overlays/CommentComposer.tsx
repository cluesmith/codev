import * as React from 'react';

export interface CommentComposerProps {
  /** 0-based source line this composer targets (for the accessible label). */
  line: number;
  /** Invoked with the trimmed, non-empty body when the reviewer submits. */
  onSubmit: (text: string) => void;
  /** Invoked when the reviewer cancels (Esc / Cancel button) without submitting. */
  onCancel: () => void;
  /**
   * Prefill body for editing an existing comment (#1055). When present the composer opens seeded
   * with this text and the submit button reads "Save"; when absent it is the empty add composer.
   */
  initialText?: string;
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
export function CommentComposer({
  line,
  onSubmit,
  onCancel,
  initialText,
}: CommentComposerProps): React.ReactElement {
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

  const submit = (): void => {
    const body = text.trim();
    if (!body) { return; } // mirrors the host's old `if (!text) return;` guard
    onSubmit(body);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
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
        <button
          type="button"
          className="codev-canvas-comment-composer-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="codev-canvas-comment-composer-submit"
          onClick={submit}
          disabled={empty}
        >
          {isEdit ? 'Save' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
