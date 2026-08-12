/**
 * The dev page (`examples/main.tsx`) implements `CommandAdapter` and exposes it as
 * `window.__canvasCommand` so the browser suite can drive the remote seam (spec 1401).
 *
 * `examples/` is outside this package's tsconfig, so the `declare global` there is invisible to
 * these specs; this mirrors it for the compilation unit that actually type-checks them.
 */
import type { CanvasCommand } from '@cluesmith/codev-types';

declare global {
  interface Window {
    __canvasCommand?: (command: CanvasCommand, count?: number) => void;
  }
}

export {};
