// Tower routes for the Decisions tab (Spec 1819).
//
//   GET  /workspace/<enc>/api/decisions             → the parsed decisions document
//   POST /workspace/<enc>/api/decisions/rule        → write the owner's ruling into the file
//   GET  /workspace/<enc>/api/decisions/image?path= → one image an item references (#1938)
//
// The document and ruling routes never read a path from the request: the file is the
// configured one, resolved and contained by file.ts at every call. A write takes its turn
// on the file, re-reads it, splices, and replaces it atomically; success returns the
// document re-parsed from the bytes just written, then tells the hub architect (#1828).
// The image route is the one that takes a path, so it fails closed (see handleDecisionsImage).

import type http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { DecisionsRefusalCode, DecisionsReadResponse, DecisionsRuleResponse } from '@cluesmith/codev-types';
import { parseJsonBody } from '../../utils/server-utils.js';
import { getMimeTypeForFile } from '../tower-utils.js';
import { configuredDecisionsPath, decisionsWriteQueue, isInside, resolveDecisionsPath, writeFileAtomic, type DecisionsLog } from './file.js';
import { rulingNotice, type RulingNotifier } from './notice.js';
import { parseDecisions, toDecisionsDocument } from './parse.js';
import { spliceRuling, type RulingRequest } from './splice.js';

/** Largest ruling request body accepted: a maximum-length comment, JSON-escaped, with room to spare. */
export const MAX_RULE_BODY_BYTES = 256 * 1024;

/** The image types the image route serves, by extension. */
export const DECISIONS_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** Largest image the image route serves. */
export const MAX_DECISIONS_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * HTTP status per refusal: bad input 400, absent 404, the file's state 409, an image too large 413
 * or of a type not served 415, a structure the splice would break 422.
 */
export const DECISIONS_REFUSAL_STATUS: Record<DecisionsRefusalCode, number> = {
  'invalid-request': 400,
  'empty-ruling': 400,
  'comment-too-long': 400,
  'comment-heading': 400,
  'comment-fence': 400,
  'comment-your-word': 400,
  'outside-workspace': 400,
  'not-found': 404,
  'open-multiple': 409,
  'heading-missing': 409,
  'heading-duplicate': 409,
  'your-word-missing': 409,
  'your-word-multiple': 409,
  'already-ruled': 409,
  'unknown-word': 409,
  'item-changed': 409,
  'structure-changed': 422,
  'image-too-large': 413,
  'not-an-image': 415,
  'not-utf8': 422,
  'config-error': 500,
  'write-failed': 500,
};

type Refusal = { ok: false; code: DecisionsRefusalCode; message: string };

function refusal(code: DecisionsRefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

function send(res: http.ServerResponse, status: number, body: DecisionsReadResponse | DecisionsRuleResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendRefusal(res: http.ServerResponse, refused: Refusal): void {
  send(res, DECISIONS_REFUSAL_STATUS[refused.code], refused);
}

/** The configured decisions file, canonical and inside the workspace, or why not. */
async function locate(workspacePath: string): Promise<{ ok: true; canonicalPath: string; displayPath: string } | Refusal> {
  let configured: string;
  try {
    configured = configuredDecisionsPath(workspacePath, { fresh: true });
  } catch (err) {
    return refusal('config-error', `The codev config could not be loaded: ${(err as Error).message}`);
  }
  const resolved = await resolveDecisionsPath(workspacePath, configured);
  if (!resolved.inside) {
    return refusal(
      'outside-workspace',
      `The decisions file ${configured} resolves to ${resolved.canonicalPath}, outside the workspace; nothing was read or written.`,
    );
  }
  if (!resolved.exists) return refusal('not-found', `There is no decisions file at ${resolved.displayPath}.`);
  return { ok: true, canonicalPath: resolved.canonicalPath, displayPath: resolved.displayPath };
}

/** The file's bytes, or `not-found` when it vanished after it was located. */
async function readBytes(canonicalPath: string, displayPath: string): Promise<Buffer | Refusal> {
  try {
    return await fsp.readFile(canonicalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return refusal('not-found', `There is no decisions file at ${displayPath}.`);
    throw err;
  }
}

/** Validate the ruling request body's shape; the splice checks its content. */
async function readRulingRequest(req: http.IncomingMessage): Promise<{ ok: true; ruling: RulingRequest } | Refusal> {
  let body: unknown;
  try {
    body = await parseJsonBody(req, MAX_RULE_BODY_BYTES);
  } catch (err) {
    return refusal('invalid-request', `The request body could not be read: ${(err as Error).message}.`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refusal('invalid-request', 'The request body must be a JSON object.');
  }
  const { id, fingerprint, word, comment } = body as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return refusal('invalid-request', '"id" must be a non-empty string.');
  if (typeof fingerprint !== 'string' || fingerprint === '') return refusal('invalid-request', '"fingerprint" must be a non-empty string.');
  if (word !== undefined && typeof word !== 'string') return refusal('invalid-request', '"word" must be a string when present.');
  if (comment !== undefined && typeof comment !== 'string') return refusal('invalid-request', '"comment" must be a string when present.');
  return { ok: true, ruling: { id, fingerprint, word, comment } };
}

/** GET …/api/decisions — the configured file, parsed. */
export async function handleDecisionsGet(res: http.ServerResponse, workspacePath: string): Promise<void> {
  const located = await locate(workspacePath);
  if (!located.ok) return sendRefusal(res, located);
  const bytes = await readBytes(located.canonicalPath, located.displayPath);
  if (!Buffer.isBuffer(bytes)) return sendRefusal(res, bytes);
  send(res, 200, { ok: true, document: toDecisionsDocument(parseDecisions(bytes.toString('utf8')), located.displayPath) });
}

function isImagePath(file: string): boolean {
  return DECISIONS_IMAGE_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase());
}

/** The image's canonical path, inside the workspace and of a type served, or why not. */
async function locateImage(workspacePath: string, requested: string): Promise<{ ok: true; canonicalPath: string } | Refusal> {
  const notAnImage = (what: string) =>
    refusal('not-an-image', `${what} is not a ${[...DECISIONS_IMAGE_EXTENSIONS].join(', ')} image, so it was not read.`);
  if (!isImagePath(requested)) return notAnImage(requested);
  const located = await locate(workspacePath);
  if (!located.ok) return located;
  const root = await fsp.realpath(workspacePath);
  // Relative to the decisions file, as any markdown viewer reads it; `/` is the workspace root.
  const target = requested.startsWith('/')
    ? path.join(root, requested)
    : path.resolve(root, path.dirname(located.displayPath), requested);
  const outside = refusal('outside-workspace', `The image ${requested} is outside the workspace, so it was not read.`);
  // Checked before the path touches the disk, so nothing outside the workspace is even probed.
  if (!isInside(root, target)) return outside;
  let canonicalPath: string;
  try {
    canonicalPath = await fsp.realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return refusal('not-found', `There is no image at ${requested}.`);
    throw err;
  }
  if (!isInside(root, canonicalPath)) return outside;
  if (!isImagePath(canonicalPath)) return notAnImage(`${requested} (a link to ${path.relative(root, canonicalPath)})`);
  return { ok: true, canonicalPath };
}

/**
 * GET …/api/decisions/image?path=<path> — one image an item's markdown references (#1938). The
 * only decisions route that takes a path from the request, so it fails closed: a relative path
 * resolves against the decisions file's directory and a `/`-rooted one against the workspace
 * root; the file served must sit inside the workspace with symlinks followed, have an image
 * extension (the link's and its target's), and be at most {@link MAX_DECISIONS_IMAGE_BYTES}.
 */
export async function handleDecisionsImage(res: http.ServerResponse, workspacePath: string, requested: string | null): Promise<void> {
  if (!requested || requested.includes('\0')) {
    return sendRefusal(res, refusal('invalid-request', '"path" must be a non-empty path.'));
  }
  const located = await locateImage(workspacePath, requested);
  if (!located.ok) return sendRefusal(res, located);
  const stat = await fsp.stat(located.canonicalPath);
  if (!stat.isFile()) return sendRefusal(res, refusal('not-found', `There is no image file at ${requested}.`));
  if (stat.size > MAX_DECISIONS_IMAGE_BYTES) {
    return sendRefusal(res, refusal(
      'image-too-large',
      `The image ${requested} is ${stat.size} bytes, over the ${MAX_DECISIONS_IMAGE_BYTES}-byte limit, so it was not read.`,
    ));
  }
  const bytes = await fsp.readFile(located.canonicalPath);
  res.writeHead(200, {
    'Content-Type': getMimeTypeForFile(located.canonicalPath),
    'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff',
    // An SVG opened as a document runs no script and loads nothing.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'no-cache',
  });
  res.end(bytes);
}

/**
 * POST …/api/decisions/rule — splice the owner's ruling into the configured file, then
 * `notify` the hub architect of it. The notice is sent only after the file is replaced,
 * and its failure is logged without touching the response: the file is the source of truth.
 */
export async function handleDecisionsRule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspacePath: string,
  log: DecisionsLog,
  notify: RulingNotifier,
): Promise<void> {
  const refuse = (refused: Refusal, id?: string): void => {
    log('WARN', `Decisions ruling refused${id ? ` for ${id}` : ''} (${refused.code}): ${refused.message}`);
    sendRefusal(res, refused);
  };

  const request = await readRulingRequest(req);
  if (!request.ok) return refuse(request);
  const { ruling } = request;
  const located = await locate(workspacePath);
  if (!located.ok) return refuse(located, ruling.id);
  const { canonicalPath, displayPath } = located;

  const outcome = await decisionsWriteQueue.run(canonicalPath, async (): Promise<{ ok: true; text: string } | Refusal> => {
    const bytes = await readBytes(canonicalPath, displayPath);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      return refusal('not-utf8', `${displayPath} is not valid UTF-8; writing a ruling would alter bytes the tab cannot read, so nothing was written.`);
    }
    const spliced = spliceRuling(text, ruling);
    if (!spliced.ok) return spliced;
    try {
      await writeFileAtomic(canonicalPath, spliced.text);
    } catch (err) {
      return refusal('write-failed', `${displayPath} could not be written (${(err as Error).message}); the file is unchanged.`);
    }
    return spliced;
  });
  if (!outcome.ok) return refuse(outcome, ruling.id);

  log('INFO', `Decisions ruling written for ${ruling.id} into ${displayPath}`);
  send(res, 200, { ok: true, document: toDecisionsDocument(parseDecisions(outcome.text), displayPath) });

  try {
    await notify(rulingNotice(ruling));
  } catch (err) {
    log('WARN', `Decisions ruling for ${ruling.id} was written, but the hub architect was not told: ${(err as Error).message}`);
  }
}
