/**
 * The Decisions panel's webview UI (Spec 1963): the shared Decisions view, active while the panel is
 * on screen, and the full-size image view over it.
 *
 * - `isActive` follows the panel's own visibility, which the extension host relays. A retained,
 *   hidden webview still reports its page as visible, so the view's page-visibility check alone
 *   would keep polling while the panel is hidden.
 * - Clicking an image in an item shows it full size here, over the view, because a webview cannot
 *   open a browser tab. The view stays mounted under it, so drafts are kept. *Close*, Escape or a
 *   click beside the image closes it.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { DecisionsView } from '@cluesmith/codev-workspace-views';
import type { FullSizeImage, WebviewDecisionsHost } from './decisions-host.js';

export interface PanelState {
  /** Whether the panel is on screen; false until the extension host says otherwise. */
  visible: boolean;
  /** The image shown full size, or null. */
  fullSize: FullSizeImage | null;
}

/** The panel's UI state, outside React so the host's messages can set it. */
export class PanelStore {
  private state: PanelState = { visible: false, fullSize: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): PanelState => this.state;

  setVisible(visible: boolean): void {
    if (this.state.visible === visible) { return; }
    this.update({ ...this.state, visible });
  }

  showImage(image: FullSizeImage): void {
    this.update({ ...this.state, fullSize: image });
  }

  closeImage(): void {
    if (this.state.fullSize === null) { return; }
    this.update({ ...this.state, fullSize: null });
  }

  private update(state: PanelState): void {
    this.state = state;
    for (const listener of this.listeners) { listener(); }
  }
}

function FullSizeView({ image, onClose }: { image: FullSizeImage; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = image.alt || 'Image';
  return (
    <div className="wv-fullsize" role="dialog" aria-modal="true" aria-label={title}>
      <div className="wv-fullsize-bar">
        <span className="wv-fullsize-title">{title}</span>
        <button ref={closeButton} type="button" className="wv-fullsize-close" onClick={onClose}>Close</button>
      </div>
      <div
        className="wv-fullsize-body"
        onClick={event => { if (event.target === event.currentTarget) { onClose(); } }}
      >
        <img src={image.src} alt={image.alt} />
      </div>
    </div>
  );
}

export function DecisionsApp({ host, store }: { host: WebviewDecisionsHost; store: PanelStore }) {
  const { visible, fullSize } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const closeImage = useCallback(() => store.closeImage(), [store]);
  return (
    <>
      <DecisionsView host={host} isActive={visible} />
      {fullSize && <FullSizeView image={fullSize} onClose={closeImage} />}
    </>
  );
}
