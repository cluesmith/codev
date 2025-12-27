/**
 * Tests for tunnel command (Spec 0062 - Secure Remote Access)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock os module FIRST, before any imports
vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(() => ({})),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
  platform: vi.fn(() => 'darwin'),
}));

// Mock the state module
vi.mock('../state.js', () => ({
  getArchitect: vi.fn(),
}));

// Mock the config module
vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({
    dashboardPort: 4200,
  })),
}));


// Mock the logger
const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  header: vi.fn(),
};
vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

// Import after mocking
const { getArchitect } = await import('../state.js');
const { tunnel } = await import('../commands/tunnel.js');
const os = await import('node:os');

describe('tunnel command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('when Agent Farm is not running', () => {
    it('should exit with error', () => {
      vi.mocked(getArchitect).mockReturnValue(null);
      // Mock process.exit to throw to stop execution
      processExitSpy.mockImplementation(() => { throw new Error('process.exit'); });

      expect(() => tunnel({})).toThrow('process.exit');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('when Agent Farm is running', () => {
    beforeEach(() => {
      vi.mocked(getArchitect).mockReturnValue({
        pid: 1234,
        port: 4201,
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });
    });

    it('should output SSH command with detected IPs', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
      });

      tunnel({});

      // Should not exit with error
      expect(processExitSpy).not.toHaveBeenCalled();

      // Should output SSH command
      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('ssh -L 4200:localhost:4200 testuser@192.168.1.50');
      expect(output).toContain('http://localhost:4200');
    });

    it('should output SSH command with placeholder when no IPs found', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({});

      tunnel({});

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('ssh -L 4200:localhost:4200 testuser@<your-ip>');
    });

    it('should filter out loopback and internal addresses', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
        en0: [
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
      });

      tunnel({});

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('192.168.1.50');
      expect(output).not.toContain('127.0.0.1');
    });

    it('should filter out IPv6 addresses', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        en0: [
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
      });

      tunnel({});

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('192.168.1.50');
      expect(output).not.toContain('fe80');
    });

    it('should show all non-loopback IPs when multiple interfaces exist', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
        en1: [
          {
            address: '10.0.0.5',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '10.0.0.5/24',
          },
        ],
      });

      tunnel({});

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('192.168.1.50');
      expect(output).toContain('10.0.0.5');
    });

    it('should include SSH config suggestion', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        en0: [
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
      });

      tunnel({});

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Host agent-farm');
      expect(output).toContain('HostName 192.168.1.50');
      expect(output).toContain('User testuser');
      expect(output).toContain('LocalForward 4200 localhost:4200');
    });
  });

  describe('Windows platform', () => {
    it('should show Windows-specific guidance', () => {
      vi.mocked(getArchitect).mockReturnValue({
        pid: 1234,
        port: 4201,
        cmd: 'claude',
        startedAt: new Date().toISOString(),
      });
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: [
          {
            address: '192.168.1.50',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.168.1.50/24',
          },
        ],
      });

      tunnel({});

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Windows requires OpenSSH Server')
      );
    });
  });
});
