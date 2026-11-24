import type { MouseEvent } from 'react';

/**
 * The click handler for a link whose opening the host owns (`openExternal`, see host.ts): the
 * view hands the URL to the host, and the click goes no further, so neither the page nor a
 * webview's own link handling opens it as well. Undefined without `open`: the link is then a
 * plain one the page opens itself.
 */
export function hostLinkClick(open: ((url: string) => void) | undefined, url: string) {
  if (!open) return undefined;
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    open(url);
  };
}
