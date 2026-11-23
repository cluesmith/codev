/**
 * `logger.row` pads cells by their VISIBLE width (#1893): a chalk-colored cell
 * carries escape codes that `padEnd` would count, under-padding it and shifting
 * every later column left on a color terminal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { logger } from '../utils/logger.js';

describe('logger.row', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aligns a colored cell with a plain one', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.row(['\x1b[33mpr (2h)\x1b[39m', 'next'], [10, 4]);
    logger.row(['plain', 'next'], [10, 4]);
    const [colored, plain] = log.mock.calls.map((c) => stripVTControlCharacters(String(c[0])));
    expect(colored.indexOf('next')).toBe(plain.indexOf('next'));
    expect(colored).toBe('  pr (2h)     next');
  });
});
