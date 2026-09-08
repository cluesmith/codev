import * as React from 'react';
import type { ReadingMode } from '../types.js';

/**
 * Keys legend (#1237): a small non-modal panel toggled with `?` while a block has focus. It only
 * documents keys that already work — nothing here handles input, and focus never moves into the
 * panel (the toggling block keeps it), so there is no focus trap to manage: `?` or Esc on the
 * focused block closes it via the body's keydown handler.
 */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Tab / Shift+Tab', 'Next / previous block or control'],
  ['Enter / Space', 'Comment on the focused block'],
  ['⌘/Ctrl+Enter', 'Submit the comment'],
  ['Esc', 'Cancel the comment · close this help'],
  ['n / p', 'Next / previous commented block'],
  ['] / [', 'Next / previous heading'],
  ['Home / End', 'First / last block'],
  ['?', 'Toggle this help'],
];

// Shown only in horizontal mode (spec 1380): the paging keys exist only there.
const HORIZONTAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['PgUp / PgDn', 'Previous / next column'],
];

export interface KeyboardHelpProps {
  /** Reading mode (spec 1380): the legend lists the column-paging keys only in horizontal. */
  readingMode?: ReadingMode;
}

export function KeyboardHelp({ readingMode = 'vertical' }: KeyboardHelpProps): React.ReactElement {
  let keys = KEYS;
  if (readingMode === 'horizontal') {
    keys = [...KEYS, ...HORIZONTAL_KEYS];
  }
  return (
    <div className="codev-canvas-keyboard-help" role="dialog" aria-label="Keyboard shortcuts">
      <ul>
        {keys.map(([k, action]) => (
          <li key={k}>
            <kbd>{k}</kbd>
            <span>{action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
