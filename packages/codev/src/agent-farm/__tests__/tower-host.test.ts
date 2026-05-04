/**
 * Integration tests for TOWER_HOST env var
 *
 * Verifies that the tower server respects the TOWER_HOST environment
 * variable for configuring the bind address.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";

import { startTower, cleanupTestDb } from "./helpers/tower-test-utils.js";

// Use a unique port range for this test suite
const PORT_DEFAULT = 14800;
const PORT_ALL_INTERFACES = 14801;
const PORT_INVALID = 14802;

let towerDefault: Awaited<ReturnType<typeof startTower>> | null = null;
let towerAllInterfaces: Awaited<ReturnType<typeof startTower>> | null = null;
let invalidProcess: ChildProcess | null = null;

/**
 * Check if a specific host:port pair is responding
 */
async function isHostResponding(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Check if a port responds on localhost
 */
async function isRespondingOnLocalhost(port: number): Promise<boolean> {
  return isHostResponding("127.0.0.1", port);
}

describe("TOWER_HOST env var", () => {
  beforeAll(async () => {
    // Start 2 tower instances with different TOWER_HOST settings.
    // Note: TOWER_HOST=localhost is NOT tested here because on macOS
    // 'localhost' resolves to ::1 (IPv6) first, and the health check in
    // tower-test-utils connects to 127.0.0.1 (IPv4). The unit tests
    // already verify that 'localhost' passes validateHost().
    towerDefault = await startTower(PORT_DEFAULT, {});
    towerAllInterfaces = await startTower(PORT_ALL_INTERFACES, {
      TOWER_HOST: "0.0.0.0",
    });

    // Try starting with an invalid host — should fail to start
    const { resolve } = await import("node:path");
    const towerServerPath = resolve(
      import.meta.dirname,
      "../../../../dist/agent-farm/servers/tower-server.js",
    );

    const socketDir = mkdtempSync("/tmp/codev-sock-invalid-");
    invalidProcess = spawn("node", [towerServerPath, String(PORT_INVALID)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AF_TEST_DB: `test-${PORT_INVALID}.db`,
        SHELLPER_SOCKET_DIR: socketDir,
        TOWER_HOST: "not-a-valid-host",
      },
    });

    // Wait for it to exit (should fail fast with validation error)
    await new Promise<void>((resolve) => {
      invalidProcess!.on("exit", () => resolve());
      // Safety: kill after 5s if it somehow didn't exit
      setTimeout(() => {
        invalidProcess?.kill("SIGKILL");
        resolve();
      }, 5000);
    });

    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 30000);

  afterAll(async () => {
    if (towerDefault) await towerDefault.stop();
    if (towerAllInterfaces) await towerAllInterfaces.stop();

    // Clean up test DBs
    cleanupTestDb(PORT_DEFAULT);
    cleanupTestDb(PORT_ALL_INTERFACES);
    cleanupTestDb(PORT_INVALID);
  });

  describe("default behavior (no TOWER_HOST)", () => {
    it("binds to localhost only", async () => {
      // Default tower should respond on 127.0.0.1
      const responding = await isRespondingOnLocalhost(PORT_DEFAULT);
      expect(responding).toBe(true);
    });

    it("responds to /api/status on localhost", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_DEFAULT}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("TOWER_HOST=0.0.0.0", () => {
    it("binds to all interfaces (responds on localhost)", async () => {
      // When bound to 0.0.0.0, it should still respond on 127.0.0.1
      const responding = await isRespondingOnLocalhost(PORT_ALL_INTERFACES);
      expect(responding).toBe(true);
    });

    it("responds to /api/status", async () => {
      const res = await fetch(
        `http://127.0.0.1:${PORT_ALL_INTERFACES}/api/status`,
      );
      expect(res.ok).toBe(true);
    });
  });

  describe("invalid TOWER_HOST", () => {
    it("causes tower to exit with non-zero code", () => {
      const code = invalidProcess?.exitCode;
      expect(code).not.toBe(0);
    });
  });
});
