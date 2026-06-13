import * as React from 'react';

export interface CommentAffordanceProps {
  /** 0-based source line this affordance targets. */
  line: number;
  /** Invoked on click / keyboard activation with the 0-based line (the D6 intent seam). */
  onActivate: (line: number) => void;
}

/**
 * The hover/focus "+" comment affordance (spec D6). It is a real `<button>`, so it is
 * keyboard-reachable (Tab) and activatable (Enter/Space) for free, with an accessible label.
 * It only signals *intent* — it never writes a marker (the host does that via MarkerAdapter.add).
 */
export function CommentAffordance({ line, onActivate }: CommentAffordanceProps): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'codev-canvas-add-comment',
      // Human-facing line numbers are 1-based; the seam value stays 0-based (D5).
      'aria-label': `Add comment on line ${line + 1}`,
      'data-add-comment-line': String(line),
      onClick: () => onActivate(line),
    },
    '+',
  );
}
