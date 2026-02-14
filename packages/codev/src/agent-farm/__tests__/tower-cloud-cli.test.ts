/**
 * Tests for tower cloud CLI flows (Spec 0097 Phase 5)
 *
 * Tests the actual towerRegister and towerDeregister functions
 * with mocked readline, browser, and HTTP interactions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';

// Redirect homedir to temp dir
const TEST_DIR = vi.hoisted(() => {
  const { resolve } = require('node:path');
  const { tmpdir } = require('node:os');
  const { randomBytes } = require('node:crypto');
  return resolve(tmpdir(), `tower-cli-test-${randomBytes(4).toString('hex')}`);
});

// Queue of answers for readline prompts (shifted one at a time)
const readlineAnswers = vi.hoisted(() => [] as string[]);

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, homedir: () => TEST_DIR };
});

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (answer: string) => void) => {
      cb(readlineAnswers.shift() || '');
    }),
    close: vi.fn(),
  })),
}));

// Mock openBrowser to trigger the callback server with a token
vi.mock('../utils/shell.js', () => ({
  openBrowser: vi.fn(async (url: string) => {
    const urlObj = new URL(url);
    const callbackUrl = urlObj.searchParams.get('callback');
    if (callbackUrl) {
      // Delay so waitForToken is called before the callback arrives
      setTimeout(() => {
        const nodeHttp = require('node:http');
        nodeHttp.get(`${callbackUrl}?token=mock-browser-token`);
      }, 50);
    }
  }),
}));

// Mock logger to suppress output; fatal throws instead of process.exit
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    header: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
  },
  fatal: vi.fn((msg: string) => {
    throw new Error(`FATAL: ${msg}`);
  }),
}));

import { towerRegister, towerDeregister } from '../commands/tower-cloud.js';
import {
  readCloudConfig,
  writeCloudConfig,
  deleteCloudConfig,
  type CloudConfig,
} from '../lib/cloud-config.js';
import { openBrowser } from '../utils/shell.js';

describe('tower cloud CLI flows (Phase 5)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    readlineAnswers.length = 0;
    vi.mocked(openBrowser).mockClear();

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : String(input);

      if (url.includes('/api/towers/register/redeem')) {
        return new Response(
          JSON.stringify({ towerId: 'tower-mock-id', apiKey: 'ctk_MockApiKey123' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Default: return 200 (signal tower, deregister DELETE, etc.)
      return new Response(null, { status: 200 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('towerRegister', () => {
    it('registers a new tower via browser callback flow', async () => {
      readlineAnswers.push('my-test-tower'); // tower name prompt

      await towerRegister();

      const config = readCloudConfig();
      expect(config).not.toBeNull();
      expect(config!.tower_id).toBe('tower-mock-id');
      expect(config!.api_key).toBe('ctk_MockApiKey123');
      expect(config!.tower_name).toBe('my-test-tower');
      expect(config!.server_url).toBe('https://codevos.ai');

      expect(openBrowser).toHaveBeenCalledWith(
        expect.stringContaining('/towers/register?callback='),
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/towers/register/redeem'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('prompts for re-registration when already registered', async () => {
      writeCloudConfig({
        tower_id: 'old-id',
        tower_name: 'old-tower',
        api_key: 'ctk_OldKey',
        server_url: 'https://codevos.ai',
      });

      readlineAnswers.push('y', 'new-tower'); // confirm + tower name

      await towerRegister();

      const config = readCloudConfig();
      expect(config!.tower_id).toBe('tower-mock-id');
      expect(config!.tower_name).toBe('new-tower');
      expect(config!.api_key).toBe('ctk_MockApiKey123');
    });

    it('cancels when user declines re-registration', async () => {
      writeCloudConfig({
        tower_id: 'old-id',
        tower_name: 'old-tower',
        api_key: 'ctk_OldKey',
        server_url: 'https://codevos.ai',
      });

      readlineAnswers.push('n'); // decline

      await towerRegister();

      const config = readCloudConfig();
      expect(config!.tower_id).toBe('old-id'); // unchanged
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it('uses --service URL for registration and browser flow', async () => {
      readlineAnswers.push('staging-tower'); // tower name prompt

      await towerRegister({ serviceUrl: 'https://staging.codevos.ai' });

      const config = readCloudConfig();
      expect(config).not.toBeNull();
      expect(config!.server_url).toBe('https://staging.codevos.ai');
      expect(config!.tower_name).toBe('staging-tower');

      // Browser should open on the custom service URL
      expect(openBrowser).toHaveBeenCalledWith(
        expect.stringContaining('https://staging.codevos.ai/towers/register?callback='),
      );

      // Token redemption should go to the custom service URL
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://staging.codevos.ai/api/towers/register/redeem'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('preserves tower name on --reauth', async () => {
      writeCloudConfig({
        tower_id: 'existing-id',
        tower_name: 'keep-this-name',
        api_key: 'ctk_OldKey',
        server_url: 'https://codevos.ai',
      });

      // No readline answers — reauth skips confirmation and name prompt

      await towerRegister({ reauth: true });

      const config = readCloudConfig();
      expect(config!.tower_name).toBe('keep-this-name');
      expect(config!.api_key).toBe('ctk_MockApiKey123');
      expect(config!.tower_id).toBe('tower-mock-id');

      expect(openBrowser).toHaveBeenCalledWith(
        expect.stringContaining('reauth=true'),
      );
    });
  });

  describe('towerDeregister', () => {
    it('deregisters without confirmation', async () => {
      writeCloudConfig({
        tower_id: 'dereg-id',
        tower_name: 'dereg-tower',
        api_key: 'ctk_DeregKey',
        server_url: 'https://codevos.ai',
      });

      await towerDeregister();

      expect(readCloudConfig()).toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/towers/dereg-id'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws fatal when not registered', async () => {
      await expect(towerDeregister()).rejects.toThrow('FATAL:');
    });
  });
});
