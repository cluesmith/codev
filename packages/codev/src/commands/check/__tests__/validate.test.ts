/**
 * Spec 1951 — input validation for `codev check`.
 */

import { describe, expect, it } from 'vitest';
import {
  InputError,
  isRefName,
  validateAbsolutePath,
  validateBuilderId,
  validateConfigString,
  validatePrNumber,
  validateSha,
} from '../validate.js';

const ABS = process.platform === 'win32' ? 'C:\\repo\\.builders\\x' : '/repo/.builders/x';

describe('Spec 1951 — validation', () => {
  it('accepts a positive PR number', () => {
    expect(validatePrNumber('1951')).toBe(1951);
  });

  it.each(['12a', '0', '012', '-1', '1.5', '', ' 12', '99999999999999999999'])('refuses PR number %j, naming it', (raw) => {
    expect(() => validatePrNumber(raw)).toThrow(InputError);
    expect(() => validatePrNumber(raw)).toThrow(JSON.stringify(raw));
  });

  it.each(['abc1234', 'a'.repeat(40)])('accepts SHA %s', (sha) => {
    expect(validateSha(sha)).toBe(sha);
  });

  it.each(['zz12', 'abc123', 'a'.repeat(41), 'ABC1234', '-abc1234'])('refuses SHA %j, naming it', (raw) => {
    expect(() => validateSha(raw)).toThrow(`invalid commit SHA ${JSON.stringify(raw)}`);
  });

  it.each(['spir-1951', 'bugfix-42', 'a.b_c'])('accepts builder id %s', (id) => {
    expect(validateBuilderId(id)).toBe(id);
  });

  it.each(['../x', 'a..b', '-x', '.x', 'a/b', 'a b', ''])('refuses builder id %j', (raw) => {
    expect(() => validateBuilderId(raw)).toThrow(InputError);
  });

  it('accepts an absolute path and refuses a relative one or a control character', () => {
    expect(validateAbsolutePath(ABS, 'worktree')).toBe(ABS);
    expect(() => validateAbsolutePath('repo/x', 'worktree')).toThrow('invalid worktree "repo/x"');
    expect(() => validateAbsolutePath(`${ABS}\n`, 'worktree')).toThrow(InputError);
  });

  it('refuses a config string that reads as an option, naming the value, key and file', () => {
    expect(() => validateConfigString('--repo=x', 'check.deploy.workflow', '/repo/.codev/config.json')).toThrow(
      'check.deploy.workflow "--repo=x" may not begin with \'-\' (in /repo/.codev/config.json)',
    );
  });

  it('refuses a config string with a control character, or an empty or non-string one', () => {
    expect(() => validateConfigString('deploy\u0007.yml', 'k', null)).toThrow('may not contain control characters');
    expect(() => validateConfigString('', 'k', null)).toThrow('must be a non-empty string');
    expect(() => validateConfigString(3, 'k', null)).toThrow('must be a non-empty string');
    expect(validateConfigString('deploy.yml', 'k', null)).toBe('deploy.yml');
  });

  it.each(['main', 'builder/spir-1951', 'refs/heads/main', 'HEAD', 'release-1.2'])('accepts ref name %s', (ref) => {
    expect(isRefName(ref)).toBe(true);
  });

  it.each(['', '-x', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a@{1}', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '.x', 'a/.b', 'a//b', '@', 'foo.lock/bar', 'a/b.lock/c'])(
    'refuses ref name %j',
    (ref) => {
      expect(isRefName(ref)).toBe(false);
    },
  );
});
