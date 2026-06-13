import type { Disposable } from '../types.js';

/**
 * JS-side theme access for canvas-drawing consumers (spec D4, Model A).
 *
 * **NOT used by the v1 render path.** v1 theming is entirely CSS-custom-property driven: the
 * component's styles bind to `--codev-canvas-*` variables and the host overrides those. This
 * adapter exists for JS-side consumers that must read an exact value — chiefly #863's `<canvas>`
 * minimap, which has to read a hex color to paint pixels. In v1 it is exercised only by a
 * standalone contract test, never by the canvas component.
 *
 * Interface only — implementations live in the host.
 */
export interface ThemeAdapter {
  /**
   * Resolve the current value of a theme token. `token` is the full custom-property name,
   * e.g. `resolve("--codev-canvas-foreground")` (spec D4 — no bare-name mapping).
   */
  resolve(token: string): string;
  /** Register a handler fired (synchronously registered) when the host theme changes. */
  onChange(handler: () => void): Disposable;
}
