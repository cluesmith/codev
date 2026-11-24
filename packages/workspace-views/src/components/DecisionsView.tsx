import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import { renderMarkdown } from '@cluesmith/codev-artifact-canvas';
import type {
  DecisionItem,
  DecisionItemProblem,
  DecisionOption,
  DecisionQaEntry,
  DecisionStamp,
  DecisionsDocument,
  DecisionsFileProblem,
} from '@cluesmith/codev-types';
import { useDecisions } from '../hooks/useDecisions.js';
import type { DecisionRulingResult, DecisionsViewHost } from '../host.js';

interface DecisionsViewProps {
  host: DecisionsViewHost;
  /** Whether the view is the one on screen: it reads the file only while it is. */
  isActive: boolean;
}

/** The view's host, for the markdown it renders at every depth (bodies, answers, `## Ruled`). */
const HostContext = createContext<DecisionsViewHost | null>(null);

function useHost(): DecisionsViewHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('DecisionsView markdown rendered outside its host');
  return host;
}

/** The owner's unsent ruling for one writable item, keyed by the item's id. */
interface Draft {
  /** The item's question as of the last edit, to name the draft if it is ever held. */
  question: string;
  word?: string;
  comment: string;
  /** A chosen word the item stopped offering: cleared from `word`, named on the card until the owner chooses again. */
  droppedWord?: string;
  /** Why the server refused the last submit. */
  refusal?: string;
}

type DraftEdit = Partial<Pick<Draft, 'word' | 'comment'>>;

type HeldReason = 'file-missing' | 'gone' | 'duplicate' | 'ruled' | 'not-writable';

/** A draft whose item stopped being writable: kept, read-only, until the owner discards it. */
interface HeldDraft {
  key: number;
  id: string;
  question: string;
  /** What the tab would have written under the item. */
  text: string;
  reason: HeldReason;
}

interface RulingState {
  drafts: ReadonlyMap<string, Draft>;
  held: readonly HeldDraft[];
  /** Items whose submit is in flight; their drafts wait for the reply before being reconciled. */
  submitting: ReadonlySet<string>;
  nextHeldKey: number;
}

const NO_RULINGS: RulingState = { drafts: new Map(), held: [], submitting: new Set(), nextHeldKey: 0 };

const HELD_REASON_TEXT: Record<HeldReason, (id: string) => ReactNode> = {
  'file-missing': () => <>The decisions file is gone, so this draft was not sent.</>,
  gone: id => <>{id} is no longer under <code>## Open</code> (main may have moved it to <code>## Ruled</code>), so this draft was not sent.</>,
  duplicate: id => <>Another open item now has the id {id}, so the tab cannot write to either, and this draft was not sent.</>,
  ruled: id => <>Text has been written under {id} since you started this draft, so the tab no longer writes to it, and this draft was not sent.</>,
  'not-writable': id => <>The tab can no longer write a ruling for {id}, so this draft was not sent.</>,
};

const FILE_PROBLEM_TEXT: Record<DecisionsFileProblem, ReactNode> = {
  'open-missing': <>This file has no <code>## Open</code> section, so there is nothing to rule on.</>,
  'open-multiple': <>This file has more than one <code>## Open</code> section. Every item is read-only until there is one.</>,
  'ruled-multiple': <>This file has more than one <code>## Ruled</code> section; only the first is read.</>,
};

const ITEM_PROBLEM_TEXT: Record<DecisionItemProblem, ReactNode> = {
  'id-missing': <>This heading has no id, so the tab cannot write a ruling for it.</>,
  'duplicate-id': <>Another open item has the same id. Items that share an id are read-only until the ids differ.</>,
  'your-word-missing': <>This item has no <code>**Your word:**</code> line, so the tab cannot write a ruling for it.</>,
  'your-word-multiple': <>This item has more than one <code>**Your word:**</code> line, so the tab cannot write a ruling for it.</>,
};

const UNCONVERTED_TEXT: Record<NonNullable<DecisionStamp['unconvertedReason']>, string> = {
  'unknown-zone': 'the time zone is not one the tab recognizes',
  'nonexistent-time': 'that time does not exist on that date in that zone (the clocks skipped it)',
  'ambiguous-time': 'that time happens twice on that date in that zone (the clocks went back)',
};

/**
 * The stamp in the viewer's local zone. Explicit fields rather than `dateStyle`/`timeStyle`:
 * Intl refuses `timeZoneName` alongside the style shorthands.
 */
export const STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/** A stamp written without a date: the time alone, so the tab never shows a date nobody wrote. */
export const STAMP_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

const EXTERNAL_LINK_RE = /^https?:\/\//i;

/**
 * One handler for every link and image in the view, since item bodies are injected HTML: an
 * http(s) link goes to the host's `openExternal`, any other link is inert, an image (outside a
 * link) that has loaded goes to the host's `showImage`, and the view never navigates away.
 */
function handleLinkClick(host: DecisionsViewHost, event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a');
  if (!anchor) {
    if (event.target instanceof HTMLImageElement) {
      // An image still loading has no source yet; a workspace image shows from its object URL.
      const src = event.target.getAttribute('src') ?? '';
      if (EXTERNAL_LINK_RE.test(src) || src.startsWith('blob:')) host.showImage?.({ src, alt: event.target.alt });
    }
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute('href')?.trim() ?? '';
  if (EXTERNAL_LINK_RE.test(href)) host.openExternal?.(href);
}

/** Where an image the browser must not load itself keeps its source until the tab loads it. */
const PARKED_SRC = 'data-decisions-src';
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** The longest source a not-loaded note shows; a `data:` URL can run to megabytes. */
const MAX_SHOWN_SOURCE = 200;

/**
 * The item markdown as HTML, with every image source that is not an http(s) URL parked in
 * {@link PARKED_SRC}: the browser would resolve a workspace path against the page's own URL,
 * which does not serve workspace files (the host's `image` does), and must not show a `data:`
 * image at all.
 * Parsed in an inert document, so nothing loads before the source is parked.
 */
function decisionsHtml(source: string): string {
  const page = new DOMParser().parseFromString(renderMarkdown(source), 'text/html');
  for (const image of page.querySelectorAll('img')) {
    image.removeAttribute('srcset');
    const src = image.getAttribute('src')?.trim() ?? '';
    if (EXTERNAL_LINK_RE.test(src)) continue;
    image.removeAttribute('src');
    image.setAttribute(PARKED_SRC, src);
  }
  return page.body.innerHTML;
}

/** The workspace path an image source names, or null for a URL of any other kind. */
function workspaceImagePath(src: string): string | null {
  if (src === '' || src.startsWith('//') || URL_SCHEME_RE.test(src)) return null;
  try {
    // The source is a URL reference: a `?query` or `#fragment` is not part of the file name, and the
    // renderer percent-encodes the rest (`my shot.png` → `my%20shot.png`), so the file is the decoded path.
    return decodeURIComponent(src.replace(/[?#].*$/s, ''));
  } catch {
    return null;
  }
}

/** Put a note in place of an image that was not loaded: its alt text and its source as written. */
function showNotLoaded(image: HTMLImageElement, source: string, reason: string) {
  const note = document.createElement('span');
  note.className = 'decisions-image-missing';
  note.title = reason;
  const label = document.createElement('span');
  label.className = 'decisions-image-missing-label';
  label.textContent = 'Image not loaded';
  const path = document.createElement('code');
  path.textContent = source.length > MAX_SHOWN_SOURCE ? `${source.slice(0, MAX_SHOWN_SOURCE)}…` : source;
  note.append(label, image.alt ? ` ${image.alt} ` : ' ', path);
  image.replaceWith(note);
}

/**
 * The shared markdown renderer, with the view's rules applied to what it renders. An http(s) link
 * opens in a new tab and any other link loses its `href`, so the rule also holds for a
 * middle-click, the context menu or the keyboard. An http(s) image loads as the browser would; any
 * other image source is a workspace path the host's `image` loads and the view shows as an object
 * URL, revoked when the markdown changes or leaves, or it is a note saying the image was not loaded.
 */
function DecisionsMarkdown({ source }: { source: string }) {
  const host = useHost();
  const ref = useRef<HTMLDivElement>(null);
  // One object per source: React 19 compares this prop by identity and re-sets the HTML whenever
  // it changes, which would wipe what the effect below did while the effect does not run again.
  const markup = useMemo(() => ({ __html: decisionsHtml(source) }), [source]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const anchor of root.querySelectorAll('a')) {
      const href = anchor.getAttribute('href')?.trim() ?? '';
      if (EXTERNAL_LINK_RE.test(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      } else {
        anchor.removeAttribute('href');
      }
    }
    const controller = new AbortController();
    const objectUrls: string[] = [];
    for (const image of root.querySelectorAll<HTMLImageElement>(`img[${PARKED_SRC}]`)) {
      const written = image.getAttribute(PARKED_SRC) ?? '';
      const path = workspaceImagePath(written);
      if (path === null) {
        showNotLoaded(image, written, 'Only an http(s) URL or a path in the workspace is shown.');
        continue;
      }
      void host.image(path, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        if (result.kind === 'not-loaded') {
          showNotLoaded(image, path, result.message);
          return;
        }
        const url = URL.createObjectURL(result.blob);
        objectUrls.push(url);
        image.addEventListener('error', () => showNotLoaded(image, path, 'The browser could not show this file as an image.'), { once: true });
        image.src = url;
      });
    }
    return () => {
      controller.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [markup, host]);
  return (
    <div ref={ref}>
      <div className="codev-artifact-canvas-rendered" dangerouslySetInnerHTML={markup} />
    </div>
  );
}

/** What a submit writes under the item, and what a held draft shows: the word, a blank line, the comment. */
function draftText(draft: Draft): string {
  return [draft.word, draft.comment.trim()].filter(Boolean).join('\n\n');
}

/** `ruling` with the draft for `id` replaced (or removed, for null) and its submit in flight or not. */
function withDraft(ruling: RulingState, id: string, draft: Draft | null, submitting: boolean): RulingState {
  const drafts = new Map(ruling.drafts);
  if (draft) drafts.set(id, draft);
  else drafts.delete(id);
  const inFlight = new Set(ruling.submitting);
  if (submitting) inFlight.add(id);
  else inFlight.delete(id);
  return { ...ruling, drafts, submitting: inFlight };
}

/** The writable item a draft is for, or why the draft must be held instead. */
function draftTarget(doc: DecisionsDocument | null, id: string): DecisionItem | HeldReason {
  if (!doc) return 'file-missing';
  const matches = doc.items.filter(item => item.id === id);
  if (matches.length === 0) return 'gone';
  if (matches.length > 1) return 'duplicate';
  const [item] = matches;
  if (item.writable) return item;
  return item.currentRuling ? 'ruled' : 'not-writable';
}

/**
 * The drafts brought in line with what the tab shows. A draft whose item is no longer writable is
 * held (or dropped, when it holds no text); a chosen word the item no longer offers is cleared and
 * named. A draft whose submit is in flight waits for the reply. Returns `ruling` itself when nothing
 * changes, so calling it on its own result changes nothing.
 */
function reconcile(ruling: RulingState, doc: DecisionsDocument | null, fileMissing: boolean): RulingState {
  if (!doc && !fileMissing) return ruling;
  let drafts: Map<string, Draft> | null = null;
  const held = [...ruling.held];
  let nextHeldKey = ruling.nextHeldKey;
  for (const [id, draft] of ruling.drafts) {
    if (ruling.submitting.has(id)) continue;
    const target = draftTarget(doc, id);
    if (typeof target === 'string') {
      drafts ??= new Map(ruling.drafts);
      drafts.delete(id);
      const text = draftText(draft);
      if (text) held.push({ key: nextHeldKey++, id, question: draft.question, text, reason: target });
      continue;
    }
    const { word, ...rest } = draft;
    if (word !== undefined && !target.options.some(option => option.word === word)) {
      drafts ??= new Map(ruling.drafts);
      drafts.set(id, { ...rest, droppedWord: word });
    }
  }
  return drafts ? { ...ruling, drafts, held, nextHeldKey } : ruling;
}

/** React keys that stay with an item when items re-order: its id, plus a count for duplicate ids. */
function itemKeys(items: DecisionItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map(item => {
    const n = seen.get(item.id) ?? 0;
    seen.set(item.id, n + 1);
    return `${item.id}#${n}`;
  });
}

function Stamp({ stamp }: { stamp: DecisionStamp }) {
  if (stamp.instant) {
    return (
      <time className="decisions-stamp" dateTime={stamp.instant} title={stamp.raw}>
        {new Date(stamp.instant).toLocaleString(undefined, stamp.timeOnly ? STAMP_TIME_FORMAT : STAMP_FORMAT)}
      </time>
    );
  }
  if (!stamp.unconvertedReason) return <span className="decisions-stamp">{stamp.raw}</span>;
  return (
    <span className="decisions-stamp decisions-stamp-unconverted">
      {stamp.raw}
      <span className="decisions-stamp-flag">
        Not converted: {UNCONVERTED_TEXT[stamp.unconvertedReason]}
      </span>
    </span>
  );
}

function QaThread({ entries }: { entries: DecisionQaEntry[] }) {
  return (
    <ol className="decisions-thread" aria-label="Questions and answers">
      {entries.map((entry, index) => (
        <li key={index} className={`decisions-thread-entry decisions-thread-${entry.kind}`}>
          <div className="decisions-thread-label">
            <span className="decisions-thread-who">{entry.kind === 'asked' ? 'You asked' : `${entry.name}'s answer`}</span>
            <span className="decisions-thread-time">{entry.time}</span>
          </div>
          <DecisionsMarkdown source={entry.markdown} />
          {entry.kind === 'asked' && !entry.answered && (
            <div className="decisions-thread-awaiting">Awaiting an answer</div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** An option as it reads: "word: what it does", then the Recommended marker. */
function OptionText({ option }: { option: DecisionOption }) {
  return (
    <>
      <span className="decisions-option-term">
        <code className="decisions-option-word">{option.word}</code>{option.description && ':'}
      </span>
      {option.description && <>{' '}<span className="decisions-option-desc">{option.description}</span></>}
      {option.recommended && <>{' '}<span className="decisions-badge">Recommended</span></>}
    </>
  );
}

function OptionList({ options }: { options: DecisionOption[] }) {
  return (
    <div className="decisions-options">
      <div className="decisions-section-label">Your word</div>
      <ul className="decisions-option-list" aria-label="Options">
        {options.map((option, index) => (
          <li key={`${option.word}#${index}`} className="decisions-option">
            <OptionText option={option} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RulingFormProps {
  item: DecisionItem;
  draft: Draft | undefined;
  submitting: boolean;
  onEdit: (item: DecisionItem, edit: DraftEdit) => void;
  onSubmit: (item: DecisionItem, draft: Draft) => void;
}

/** A writable card's options, comment box and Submit. Read-only while its submit is in flight, so no keystroke is lost when it clears. */
function RulingForm({ item, draft, submitting, onEdit, onSubmit }: RulingFormProps) {
  const optionsName = useId();
  const commentId = useId();
  const word = draft?.word;
  const comment = draft?.comment ?? '';
  const canSubmit = !submitting && draft !== undefined && draftText(draft) !== '';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit && draft) onSubmit(item, draft);
  };

  return (
    <form className="decisions-form" onSubmit={handleSubmit}>
      {item.options.length > 0 && (
        <fieldset className="decisions-options" disabled={submitting}>
          <legend className="decisions-section-label">Your word</legend>
          {item.options.map((option, index) => (
            <label key={`${option.word}#${index}`} className="decisions-option decisions-choice">
              <input
                type="radio"
                name={optionsName}
                value={option.word}
                checked={word === option.word}
                onChange={() => onEdit(item, { word: option.word })}
              />
              {' '}<OptionText option={option} />
            </label>
          ))}
          {word !== undefined && (
            <button type="button" className="decisions-link-btn" onClick={() => onEdit(item, { word: undefined })}>
              Clear choice
            </button>
          )}
        </fieldset>
      )}
      {draft?.droppedWord && (
        <div className="decisions-notice" role="status">
          The option <code>{draft.droppedWord}</code> you chose is no longer offered, so your choice was cleared.
          {comment.trim() && ' Your comment is kept.'}
        </div>
      )}
      <label htmlFor={commentId} className="decisions-section-label decisions-comment-label">Comment or question</label>
      <textarea
        id={commentId}
        className="decisions-comment"
        rows={3}
        value={comment}
        readOnly={submitting}
        placeholder="Anything to add to your word, or instead of one; or a question to have answered before you rule."
        onChange={event => onEdit(item, { comment: event.target.value })}
      />
      {draft?.refusal && <div className="decisions-error" role="alert">{draft.refusal}</div>}
      <div className="decisions-form-actions">
        <button type="submit" className="decisions-submit-btn" disabled={!canSubmit}>
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </form>
  );
}

interface HeldDraftsProps {
  held: readonly HeldDraft[];
  domId: (key: number) => string;
  onDiscard: (key: number) => void;
}

function HeldDrafts({ held, domId, onDiscard }: HeldDraftsProps) {
  return (
    <section className="decisions-held" aria-label="Held drafts">
      {held.map(draft => (
        <article
          key={draft.key}
          id={domId(draft.key)}
          className="decisions-card decisions-held-card"
          aria-label={`Held draft for ${draft.id}`}
        >
          <div className="decisions-card-meta">
            <span className="decisions-item-id">{draft.id}</span>
            <span className="decisions-held-tag">Held draft</span>
          </div>
          {draft.question && <div className="decisions-held-question">{draft.question}</div>}
          <div className="decisions-notice" role="note">{HELD_REASON_TEXT[draft.reason](draft.id)}</div>
          <pre className="decisions-ruling-text decisions-held-text">{draft.text}</pre>
          <div className="decisions-form-actions">
            <button type="button" className="decisions-discard-btn" onClick={() => onDiscard(draft.key)}>Discard</button>
          </div>
        </article>
      ))}
    </section>
  );
}

/** Shown verbatim, not rendered, so everything main's scan reads is visible (a REVIEW comment too). */
function CurrentRuling({ text }: { text: string }) {
  return (
    <div className="decisions-ruling">
      <div className="decisions-section-label">Written under this item</div>
      <pre className="decisions-ruling-text">{text}</pre>
      <p className="decisions-ruling-note">
        You have written under this item, and main will act on it. To change it, tell main or edit
        the file by hand.
      </p>
    </div>
  );
}

interface RulingHandlers {
  onEdit: RulingFormProps['onEdit'];
  onSubmit: RulingFormProps['onSubmit'];
  onShowHeld: (key: number) => void;
}

function DecisionCard({ item, ruling, handlers }: { item: DecisionItem; ruling: RulingState; handlers: RulingHandlers }) {
  const questionId = useId();
  const idLabelId = useId();
  const heldDraft = ruling.held.filter(draft => draft.id === item.id).at(-1);
  return (
    <article className="decisions-card" aria-labelledby={item.question ? questionId : idLabelId}>
      <div className="decisions-card-meta">
        <span id={idLabelId} className="decisions-item-id">{item.id || '(no id)'}</span>
        {item.stamp && <Stamp stamp={item.stamp} />}
      </div>
      {item.question && <h3 id={questionId} className="decisions-card-question">{item.question}</h3>}
      {item.problems.map(problem => (
        <div key={problem} className="decisions-notice" role="note">{ITEM_PROBLEM_TEXT[problem]}</div>
      ))}
      {item.bodyMarkdown && <div className="decisions-card-body"><DecisionsMarkdown source={item.bodyMarkdown} /></div>}
      {item.qa.length > 0 && <QaThread entries={item.qa} />}
      {item.writable ? (
        <RulingForm
          item={item}
          draft={ruling.drafts.get(item.id)}
          submitting={ruling.submitting.has(item.id)}
          onEdit={handlers.onEdit}
          onSubmit={handlers.onSubmit}
        />
      ) : (
        item.options.length > 0 && <OptionList options={item.options} />
      )}
      {item.currentRuling && <CurrentRuling text={item.currentRuling} />}
      {heldDraft && (
        <div className="decisions-notice decisions-held-pointer" role="note">
          An unsent draft for this item is held at the top of the tab.{' '}
          <button type="button" className="decisions-link-btn" onClick={() => handlers.onShowHeld(heldDraft.key)}>
            Show it
          </button>
        </div>
      )}
    </article>
  );
}

function DecisionsBody({ doc, ruling, handlers }: { doc: DecisionsDocument; ruling: RulingState; handlers: RulingHandlers }) {
  const keys = itemKeys(doc.items);
  return (
    <>
      {doc.problems.map(problem => (
        <div key={problem} className="decisions-notice" role="status">{FILE_PROBLEM_TEXT[problem]}</div>
      ))}
      {doc.items.length > 0 ? (
        <div className="decisions-cards">
          {doc.items.map((item, index) => <DecisionCard key={keys[index]} item={item} ruling={ruling} handlers={handlers} />)}
        </div>
      ) : (
        !doc.problems.includes('open-missing') && <div className="decisions-empty">No open decisions.</div>
      )}
      <details className="decisions-ruled">
        <summary>Ruled</summary>
        {doc.ruledMarkdown
          ? <DecisionsMarkdown source={doc.ruledMarkdown} />
          : <div className="decisions-ruled-empty">Nothing under <code>## Ruled</code> yet.</div>}
      </details>
    </>
  );
}

/**
 * Spec 1819: the Decisions view — the workspace's pending-decisions file, read and ruled through
 * the host. A host keeps it mounted while it is hidden (the dashboard while its tab exists), so its
 * state — the drafts with it — survives being hidden.
 */
export function DecisionsView({ host, isActive }: DecisionsViewProps) {
  const { state, applyDocument } = useDecisions(host.read, isActive);
  const doc = state.status === 'ready' ? state.document
    : state.status === 'error' ? state.lastDocument
      : null;

  const [stored, setRuling] = useState<RulingState>(NO_RULINGS);
  // Adjusting state during render (React's pattern for state derived from new input): the
  // re-render happens before anything is committed, so no frame shows a stale draft.
  const ruling = reconcile(stored, doc, state.status === 'not-found');
  if (ruling !== stored) setRuling(ruling);

  // Edits only reach a card that is not submitting: its controls are read-only while it is.
  const onEdit = useCallback((item: DecisionItem, edit: DraftEdit) => {
    setRuling(prev => {
      const draft: Draft = { ...(prev.drafts.get(item.id) ?? { comment: '' }), ...edit, question: item.question };
      if ('word' in edit) delete draft.droppedWord;
      return withDraft(prev, item.id, draft, false);
    });
  }, []);

  const onSubmit = useCallback(async (item: DecisionItem, draft: Draft) => {
    setRuling(prev => withDraft(prev, item.id, { ...draft, refusal: undefined }, true));
    let result: DecisionRulingResult;
    try {
      result = await host.rule({
        id: item.id,
        fingerprint: item.fingerprint,
        word: draft.word,
        comment: draft.comment.trim() || undefined,
      });
    } catch (err) {
      // It is written never to throw; if it does, say so on the card rather than leave it locked.
      result = { kind: 'error', message: `The ruling could not be sent: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result.kind === 'document') {
      applyDocument(result.document);
      setRuling(prev => withDraft(prev, item.id, null, false));
    } else {
      setRuling(prev => withDraft(prev, item.id, { ...draft, refusal: result.message }, false));
    }
  }, [applyDocument, host]);

  const onDiscard = useCallback((key: number) => {
    setRuling(prev => ({ ...prev, held: prev.held.filter(draft => draft.key !== key) }));
  }, []);

  // A held draft sits at the top of the tab, likely scrolled away from the card it came from.
  const heldIdPrefix = useId();
  const heldDomId = useCallback((key: number) => `${heldIdPrefix}held-${key}`, [heldIdPrefix]);
  const onShowHeld = useCallback((key: number) => {
    document.getElementById(heldDomId(key))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [heldDomId]);

  const handlers: RulingHandlers = { onEdit, onSubmit, onShowHeld };
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => handleLinkClick(host, event), [host]);

  return (
    <HostContext.Provider value={host}>
      <div className="decisions-view" onClick={onClick}>
        <div className="decisions-content">
          <div className="decisions-header">
            <h2 className="decisions-title">Decisions</h2>
            {doc && <span className="decisions-count">{doc.items.length} open</span>}
          </div>
          {doc && <div className="decisions-path"><code>{doc.path}</code></div>}
          {state.status === 'loading' && <div className="decisions-loading">Loading decisions…</div>}
          {state.status === 'not-found' && <div className="decisions-notice" role="status">{state.message}</div>}
          {state.status === 'error' && (
            <div className="decisions-error" role="alert">
              {state.message}
              {state.lastDocument && ' Showing the last version read.'}
            </div>
          )}
          {ruling.held.length > 0 && <HeldDrafts held={ruling.held} domId={heldDomId} onDiscard={onDiscard} />}
          {doc && <DecisionsBody doc={doc} ruling={ruling} handlers={handlers} />}
        </div>
      </div>
    </HostContext.Provider>
  );
}
