import * as React from 'react';
import type { ReadingMode } from '../types.js';

export interface ReadingModeToggleProps {
  /** Current mode; the button renders as a pressed toggle when `horizontal`. */
  mode: ReadingMode;
  /** Invoked on activation — the canvas flips the mode and emits the host intent (D4). */
  onToggle(): void;
}

/**
 * Columns glyph drawn from static path data (no user input; same rationale as the marker-card
 * icons: the package is host-agnostic, so no icon font can be assumed). Two vertical bars —
 * the multi-column page. `currentColor` lets the button's CSS drive the tint.
 */
function ColumnsIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 2.5h4.6v11H2.5z" />
      <path d="M8.9 2.5h4.6v11H8.9z" />
    </svg>
  );
}

/**
 * The reading-mode toggle (spec 1380 D4): a real `<button>` in canvas chrome, so every host
 * gets the control without host work. `aria-pressed` carries the state (pressed = horizontal),
 * and the accessible name stays constant — toggle-button convention, so screen readers
 * announce "Horizontal reading mode, pressed/not pressed" rather than a name that flips.
 */
export function ReadingModeToggle({ mode, onToggle }: ReadingModeToggleProps): React.ReactElement {
  const horizontal = mode === 'horizontal';
  let title = 'Switch to horizontal (multi-column) reading';
  if (horizontal) {
    title = 'Switch to vertical reading';
  }
  return (
    <button
      type="button"
      className="codev-canvas-reading-mode-toggle"
      aria-pressed={horizontal}
      aria-label="Horizontal reading mode"
      title={title}
      onClick={onToggle}
    >
      <ColumnsIcon />
    </button>
  );
}
