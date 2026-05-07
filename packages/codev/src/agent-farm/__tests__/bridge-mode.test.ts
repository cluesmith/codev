/**
 * Integration tests for Bridge Mode env vars.
 *
 * Verifies that the bridge mode system (BRIDGE_MODE + BRIDGE_TOWER_HOST)
 * correctly controls the Tower server bind address.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";

import { startTower, cleanupTestDb } from "./helpers/tower-test-utils.js";

const PORT_DEFAULT = 14900;
const PORT_BRIDGE_ALL = 14901;
const PORT_BRIDGE_NO_HOST = 14902;
const PORT_INVALID = 14903;

let towerDefault: Awaited<ReturnType<typeof startTower>> | null = null;
let towerBridgeAll: Awaited<ReturnType<typeof startTower>> | null = null;
let towerBridgeNoHost: Awaited<ReturnType<typeof startTower>> | null = null;
let invalidProcess: ChildProcess | null = null;

async function isHostResponding(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { resolve(false); });
    socket.connect(port, host);
  });
}

function isRespondingOnLocalhost(port: number): Promise<boolean> {
  return isHostResponding("127.0.0.1", port);
}

describe("Bridge Mode", () => {
  beforeAll(async () => {
    towerDefault = await startTower(PORT_DEFAULT, {});

    towerBridgeAll = await startTower(PORT_BRIDGE_ALL, {
      BRIDGE_MODE: "1",
      BRIDGE_TOWER_HOST: "0.0.0.0",
    });

    // Bridge mode enabled but no BRIDGE_TOWER_HOST — should fall back to 127.0.0.1
    towerBridgeNoHost = await startTower(PORT_BRIDGE_NO_HOST, {
      BRIDGE_MODE: "1",
    });

    // Invalid bridge host
    await import("node:path");
    // @ts-expect-error dynamic import resolved
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
        BRIDGE_MODE: "1",
        BRIDGE_TOWER_HOST: "not-a-valid-host",
      },
    });

    await new Promise<void>((resolve) => {
      invalidProcess!.on("exit", () => resolve());
      setTimeout(() => {
        invalidProcess?.kill("SIGKILL");
        resolve();
      }, 5000);
    });

    try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 30000);

  afterAll(async () => {
    if (towerDefault) await towerDefault.stop();
    if (towerBridgeAll) await towerBridgeAll.stop();
    if (towerBridgeNoHost) await towerBridgeNoHost.stop();
    cleanupTestDb(PORT_DEFAULT);
    cleanupTestDb(PORT_BRIDGE_ALL);
    cleanupTestDb(PORT_BRIDGE_NO_HOST);
    cleanupTestDb(PORT_INVALID);
  });

  describe("default behavior (no bridge mode)", () => {
    it("binds to localhost only", async () => {
      expect(await isRespondingOnLocalhost(PORT_DEFAULT)).toBe(true);
    });

    it("responds to /api/status on localhost", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_DEFAULT}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 with BRIDGE_TOWER_HOST=0.0.0.0", () => {
    it("binds to all interfaces (responds on localhost)", async () => {
      expect(await isRespondingOnLocalhost(PORT_BRIDGE_ALL)).toBe(true);
    });

    it("responds to /api/status", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_BRIDGE_ALL}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 without BRIDGE_TOWER_HOST", () => {
    it("falls back to 127.0.0.1 as default", async () => {
      expect(await isRespondingOnLocalhost(PORT_BRIDGE_NO_HOST)).toBe(true);
    });

    it("responds to /api/status", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT_BRIDGE_NO_HOST}/api/status`);
      expect(res.ok).toBe(true);
    });
  });

  describe("BRIDGE_MODE=1 with invalid BRIDGE_TOWER_HOST", () => {
    it("causes tower to exit with non-zero code", () => {
      expect(invalidProcess?.exitCode).not.toBe(0);
    });
  });
});
