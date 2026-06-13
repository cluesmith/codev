import type { Disposable } from '../types.js';

/**
 * Reads document content and notifies on external change.
 *
 * Async/sync split (spec D2): `read` is async (Promise-returning); `watch` is **synchronous**
 * — it registers a subscription and returns a `Disposable` immediately, while change
 * notifications arrive asynchronously via the supplied callback.
 *
 * This is an interface only — implementations live in the host (spec: adapters carry no
 * implementations in the package).
 */
export interface FileAdapter {
  /** Read the current document content for `uri`. */
  read(uri: string): Promise<string>;
  /**
   * Subscribe to external changes to `uri`. Returns a `Disposable` synchronously; `onChange`
   * fires (asynchronously) with the new content. The host is responsible for any
   * debouncing/coalescing before invoking `onChange` (spec D2).
   */
  watch(uri: string, onChange: (content: string) => void): Disposable;
}
