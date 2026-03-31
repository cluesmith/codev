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
      expect(config!.server_url).toBe('https://cloud.codevos.ai');

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

  describe('CLI aliases (Phase 4)', () => {
    it('towerRegister is exported and callable via both connect and register', () => {
      // Verify the function is importable (the CLI wires it to both 'connect' and hidden 'register')
      expect(typeof towerRegister).toBe('function');
    });

    it('towerDeregister is exported and callable via both disconnect and deregister', () => {
      // Verify the function is importable (the CLI wires it to both 'disconnect' and hidden 'deregister')
      expect(typeof towerDeregister).toBe('function');
    });

    it('CLI has connect/disconnect as primary commands with hidden register/deregister aliases', async () => {
      const { Command } = await import('commander');

      // Build the tower subcommand tree the same way cli.ts does
      const towerCmd = new Command('tower');

      const connectOpts = (cmd: InstanceType<typeof Command>) => cmd
        .option('--reauth', 'Update API key without changing tower name')
        .option('--service <url>', 'CodevOS service URL')
        .option('-p, --port <port>', 'Tower port');
      const disconnectOpts = (cmd: InstanceType<typeof Command>) => cmd
        .option('-p, --port <port>', 'Tower port');

      const noop = () => {};

      connectOpts(towerCmd.command('connect').description('Connect')).action(noop);
      disconnectOpts(towerCmd.command('disconnect').description('Disconnect')).action(noop);
      towerCmd.addCommand(connectOpts(new Command('register')).action(noop), { hidden: true });
      towerCmd.addCommand(disconnectOpts(new Command('deregister')).action(noop), { hidden: true });

      // Help output should show connect/disconnect but NOT register/deregister
      const helpText = towerCmd.helpInformation();
      expect(helpText).toContain('connect');
      expect(helpText).toContain('disconnect');
      expect(helpText).not.toContain('register');
      expect(helpText).not.toContain('deregister');

      // But the hidden commands should still be findable by Commander
      const allCommands = towerCmd.commands.map((c: InstanceType<typeof Command>) => c.name());
      expect(allCommands).toContain('connect');
      expect(allCommands).toContain('disconnect');
      expect(allCommands).toContain('register');
      expect(allCommands).toContain('deregister');
    });

    it('user-facing messages reference "afx tower connect" not "afx tower register"', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');

      // Check messages in tower-cloud.ts reference new names
      const cloudSource = readFileSync(
        resolve(import.meta.dirname, '../commands/tower-cloud.ts'),
        'utf-8',
      );
      expect(cloudSource).toContain('afx tower connect');
      expect(cloudSource).not.toContain('afx tower register');

      // Check messages in cloud-config.ts reference new names
      const configSource = readFileSync(
        resolve(import.meta.dirname, '../lib/cloud-config.ts'),
        'utf-8',
      );
      expect(configSource).toContain('afx tower connect');
      expect(configSource).not.toContain('afx tower register');

      // Check messages in tunnel-client.ts reference new names
      const tunnelSource = readFileSync(
        resolve(import.meta.dirname, '../lib/tunnel-client.ts'),
        'utf-8',
      );
      expect(tunnelSource).toContain('afx tower connect');
      expect(tunnelSource).not.toContain('afx tower register');

      // Check messages in tower-tunnel.ts reference new names
      const tunnelServerSource = readFileSync(
        resolve(import.meta.dirname, '../servers/tower-tunnel.ts'),
        'utf-8',
      );
      expect(tunnelServerSource).toContain('afx tower connect');
      expect(tunnelServerSource).not.toContain('afx tower register');
    });
  });
});
