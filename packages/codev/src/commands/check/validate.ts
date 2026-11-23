/**
 * Input validation for `codev check` (Spec 1951).
 *
 * Every value that reaches a git argv or a forge concept is validated here before any
 * subprocess runs. A violation is an `InputError`, which the commands report as exit 2
 * naming the value (and, for configuration, the key and the file it came from).
 */

import { isAbsolute } from 'node:path';

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PR_NUMBER = /^[1-9]\d*$/;
const BUILDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function isSha(value: string): boolean {
  return SHA.test(value);
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/**
 * A branch or ref name as git accepts it, restricted to what `codev check` ever passes:
 * no leading `-`, no whitespace or control characters, none of `~ ^ : ? * [ \`, no `..`,
 * no `@{`, no component beginning with `.`, and not ending in `/`, `.` or `.lock`.
 */
export function isRefName(value: string): boolean {
  if (value === '' || value.startsWith('-') || value.startsWith('/')) return false;
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//') || value.includes('/.')) return false;
  if (value.startsWith('.') || value === '@') return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  return true;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function validatePrNumber(raw: string): number {
  if (!PR_NUMBER.test(raw)) throw new InputError(`invalid PR number ${quote(raw)}: expected a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new InputError(`invalid PR number ${quote(raw)}: too large`);
  return value;
}

export function validateSha(raw: string): string {
  if (!isSha(raw)) throw new InputError(`invalid commit SHA ${quote(raw)}: expected 7–40 hex characters`);
  return raw;
}

export function validateBuilderId(raw: string): string {
  if (!BUILDER_ID.test(raw) || raw.includes('..')) {
    throw new InputError(`invalid builder id ${quote(raw)}: expected letters, digits, '.', '_' or '-'`);
  }
  return raw;
}

/** A directory handed to git as `-C <dir>`: absolute, no control characters. */
export function validateAbsolutePath(raw: string, what: string): string {
  if (!isAbsolute(raw) || hasControlChars(raw)) throw new InputError(`invalid ${what} ${quote(raw)}: expected an absolute path`);
  return raw;
}

/**
 * A configuration string that is passed to git or to a forge concept. It may not begin
 * with `-` (it would read as an option) and may not contain a control character.
 */
export function validateConfigString(value: unknown, key: string, source: string | null): string {
  const where = source ? ` (in ${source})` : '';
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(`${key} must be a non-empty string${where}`);
  if (value.startsWith('-')) throw new InputError(`${key} ${quote(value)} may not begin with '-'${where}`);
  if (hasControlChars(value)) throw new InputError(`${key} ${quote(value)} may not contain control characters${where}`);
  return value;
}
