/**
 * The dashboard as the Decisions view's host (Spec 1963): the decisions routes through lib/api.ts,
 * with the key, and links and full-size images in new browser tabs.
 */

import type { DecisionsViewHost } from '@cluesmith/codev-workspace-views';
import { fetchDecisionImage, fetchDecisions, postDecisionRuling } from './api.js';

const EXTERNAL_LINK_RE = /^https?:\/\//i;

/** How long a full-size image page stays openable after the click that made it. */
const FULL_SIZE_PAGE_MS = 60_000;

function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener');
}

/**
 * Open an image full size in a new tab. A workspace image is a blob of the dashboard's origin,
 * so it is shown on a page holding only an `<img>` of it: an SVG opened as a document itself
 * would run its scripts as the dashboard.
 */
function openFullSize({ src, alt }: { src: string; alt: string }) {
  if (EXTERNAL_LINK_RE.test(src)) {
    openInNewTab(src);
    return;
  }
  if (!src.startsWith('blob:')) return;
  const page = document.implementation.createHTMLDocument(alt || 'Image');
  const full = page.createElement('img');
  full.alt = alt;
  full.src = src;
  page.body.append(full);
  const pageUrl = URL.createObjectURL(new Blob([`<!doctype html>${page.documentElement.outerHTML}`], { type: 'text/html' }));
  openInNewTab(pageUrl);
  setTimeout(() => URL.revokeObjectURL(pageUrl), FULL_SIZE_PAGE_MS);
}

export const dashboardDecisionsHost: DecisionsViewHost = {
  read: fetchDecisions,
  rule: postDecisionRuling,
  image: fetchDecisionImage,
  openExternal: openInNewTab,
  showImage: openFullSize,
};
