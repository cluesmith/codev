/**
 * Tests for tower server reverse proxy functionality
 * Tests Base64URL encoding/decoding and terminal port routing
 */
import { describe, it, expect } from 'vitest';

// Test helper: Encode string to Base64URL (matching browser implementation)
function toBase64URL(str: string): string {
  const base64 = Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Test helper: Decode Base64URL to string (matching server implementation)
function fromBase64URL(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf-8');
}

// Test helper: Calculate terminal port from base port and terminal type
function calculateTargetPort(
  basePort: number,
  terminalType: string | undefined,
  builderNum?: number
): number {
  if (terminalType === 'architect') {
    return basePort + 1; // Architect terminal
  } else if (terminalType === 'builder' && builderNum !== undefined && !isNaN(builderNum)) {
    return basePort + 2 + builderNum; // Builder terminal
  }
  return basePort; // Default: project dashboard
}

describe('Tower Proxy - Base64URL Encoding', () => {
  it('should encode simple paths correctly', () => {
    const path = '/Users/test/project';
    const encoded = toBase64URL(path);
    const decoded = fromBase64URL(encoded);
    expect(decoded).toBe(path);
  });

  it('should handle paths with slashes correctly (no slash issues)', () => {
    const path = '/Users/test/my/deep/nested/project';
    const encoded = toBase64URL(path);
    // Ensure no slashes in encoded output (Base64URL replaces / with _)
    expect(encoded).not.toContain('/');
    expect(fromBase64URL(encoded)).toBe(path);
  });

  it('should handle unicode paths correctly', () => {
    const path = '/Users/test/日本語/プロジェクト';
    const encoded = toBase64URL(path);
    expect(fromBase64URL(encoded)).toBe(path);
  });

  it('should handle long paths (1000+ characters)', () => {
    const path = '/Users/test/' + 'a'.repeat(1000);
    const encoded = toBase64URL(path);
    expect(fromBase64URL(encoded)).toBe(path);
  });

  it('should handle Windows-style paths', () => {
    const path = 'C:\\Users\\test\\project';
    const encoded = toBase64URL(path);
    expect(fromBase64URL(encoded)).toBe(path);
  });

  it('should handle paths with spaces', () => {
    const path = '/Users/test/my project/code';
    const encoded = toBase64URL(path);
    expect(fromBase64URL(encoded)).toBe(path);
  });

  it('should handle paths with special characters', () => {
    const path = '/Users/test/project@2024/code#main';
    const encoded = toBase64URL(path);
    expect(fromBase64URL(encoded)).toBe(path);
  });
});

describe('Tower Proxy - Terminal Port Routing', () => {
  const basePort = 4200;

  it('should route dashboard to base_port', () => {
    expect(calculateTargetPort(basePort, undefined)).toBe(4200);
    expect(calculateTargetPort(basePort, '')).toBe(4200);
  });

  it('should route architect to base_port + 1', () => {
    expect(calculateTargetPort(basePort, 'architect')).toBe(4201);
  });

  it('should route builder/0 to base_port + 2', () => {
    expect(calculateTargetPort(basePort, 'builder', 0)).toBe(4202);
  });

  it('should route builder/5 to base_port + 7', () => {
    expect(calculateTargetPort(basePort, 'builder', 5)).toBe(4207);
  });

  it('should route builder/10 to base_port + 12', () => {
    expect(calculateTargetPort(basePort, 'builder', 10)).toBe(4212);
  });

  it('should fall through to dashboard for builder without valid number', () => {
    expect(calculateTargetPort(basePort, 'builder', NaN)).toBe(4200);
  });

  it('should handle different base ports correctly', () => {
    expect(calculateTargetPort(4300, 'architect')).toBe(4301);
    expect(calculateTargetPort(4300, 'builder', 0)).toBe(4302);
    expect(calculateTargetPort(4400, 'builder', 3)).toBe(4405);
  });

  it('should handle unknown terminal types as dashboard', () => {
    expect(calculateTargetPort(basePort, 'unknown')).toBe(4200);
    expect(calculateTargetPort(basePort, 'other')).toBe(4200);
  });
});

describe('Tower Proxy - Path Validation', () => {
  function isValidProjectPath(path: string): boolean {
    if (!path) return false;
    // Support both POSIX (/) and Windows (C:\) paths
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  }

  it('should accept POSIX absolute paths', () => {
    expect(isValidProjectPath('/Users/test/project')).toBe(true);
    expect(isValidProjectPath('/home/user/project')).toBe(true);
    expect(isValidProjectPath('/var/www/project')).toBe(true);
  });

  it('should accept Windows absolute paths', () => {
    expect(isValidProjectPath('C:\\Users\\test\\project')).toBe(true);
    expect(isValidProjectPath('D:/Projects/code')).toBe(true);
    expect(isValidProjectPath('E:\\work')).toBe(true);
  });

  it('should reject relative paths', () => {
    expect(isValidProjectPath('project')).toBe(false);
    expect(isValidProjectPath('./project')).toBe(false);
    expect(isValidProjectPath('../project')).toBe(false);
  });

  it('should reject empty paths', () => {
    expect(isValidProjectPath('')).toBe(false);
  });
});

describe('Tower Proxy - URL Path Parsing', () => {
  function parseProxyPath(pathname: string): {
    encodedPath: string | null;
    terminalType: string | null;
    builderNum: number | null;
    remainingPath: string;
  } {
    if (!pathname.startsWith('/project/')) {
      return { encodedPath: null, terminalType: null, builderNum: null, remainingPath: '' };
    }

    const pathParts = pathname.split('/');
    // ['', 'project', base64urlPath, terminalType, ...rest]
    const encodedPath = pathParts[2] || null;
    const terminalType = pathParts[3] || null;
    const rest = pathParts.slice(4);

    let builderNum: number | null = null;
    let remainingPath = rest.join('/');

    if (terminalType === 'builder' && rest[0]) {
      const parsed = parseInt(rest[0], 10);
      if (!isNaN(parsed)) {
        builderNum = parsed;
        remainingPath = rest.slice(1).join('/');
      }
    }

    return { encodedPath, terminalType, builderNum, remainingPath };
  }

  it('should parse dashboard path', () => {
    const result = parseProxyPath('/project/L1VzZXJzL3Rlc3Q/');
    expect(result.encodedPath).toBe('L1VzZXJzL3Rlc3Q');
    // Empty string after trailing slash is falsy, so terminalType is null
    expect(result.terminalType).toBeNull();
    expect(result.builderNum).toBeNull();
    expect(result.remainingPath).toBe('');
  });

  it('should parse architect path', () => {
    const result = parseProxyPath('/project/L1VzZXJzL3Rlc3Q/architect/');
    expect(result.encodedPath).toBe('L1VzZXJzL3Rlc3Q');
    expect(result.terminalType).toBe('architect');
    expect(result.builderNum).toBeNull();
    expect(result.remainingPath).toBe('');
  });

  it('should parse builder path with number', () => {
    const result = parseProxyPath('/project/L1VzZXJzL3Rlc3Q/builder/0/');
    expect(result.encodedPath).toBe('L1VzZXJzL3Rlc3Q');
    expect(result.terminalType).toBe('builder');
    expect(result.builderNum).toBe(0);
    expect(result.remainingPath).toBe('');
  });

  it('should parse builder path with higher number', () => {
    const result = parseProxyPath('/project/L1VzZXJzL3Rlc3Q/builder/5/ws');
    expect(result.encodedPath).toBe('L1VzZXJzL3Rlc3Q');
    expect(result.terminalType).toBe('builder');
    expect(result.builderNum).toBe(5);
    expect(result.remainingPath).toBe('ws');
  });

  it('should handle additional path segments', () => {
    const result = parseProxyPath('/project/L1VzZXJzL3Rlc3Q/architect/ws');
    expect(result.encodedPath).toBe('L1VzZXJzL3Rlc3Q');
    expect(result.terminalType).toBe('architect');
    expect(result.remainingPath).toBe('ws');
  });

  it('should handle non-project paths', () => {
    const result = parseProxyPath('/api/status');
    expect(result.encodedPath).toBeNull();
    expect(result.terminalType).toBeNull();
  });
});
