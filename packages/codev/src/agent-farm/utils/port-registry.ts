/**
 * Global Port Registry
 *
 * Manages port block allocation across multiple repositories to prevent
 * port conflicts when running multiple architect sessions simultaneously.
 *
 * Registry location: ~/.agent-farm/global.db
 * Each repository gets a 100-port block (e.g., 4200-4299, 4300-4399, etc.)
 *
 * Uses SQLite with ACID transactions for proper concurrency handling.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGlobalDb, closeGlobalDb } from '../db/index.js';
import type { DbPortAllocation } from '../db/types.js';

// Base port for first allocation
const BASE_PORT = 4200;
// Ports per project
const PORT_BLOCK_SIZE = 100;
// Maximum allocations (4200-9999 = ~58 projects)
const MAX_ALLOCATIONS = 58;

// Port blocks to skip (base ports that conflict with system services)
// 5000: macOS AirPlay Receiver (ControlCenter)
const BLOCKED_PORT_BLOCKS = [5000];

/**
 * Check if a process is still running
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a project path still exists on disk
 */
function projectExists(projectPath: string): boolean {
  return existsSync(projectPath);
}

/**
 * Clean up stale registry entries (projects that no longer exist or have dead PIDs)
 * Note: This function is now synchronous
 */
export function cleanupStaleEntries(): { removed: string[]; remaining: number } {
  const db = getGlobalDb();
  const removed: string[] = [];

  // Get all allocations
  const allocations = db.prepare('SELECT * FROM port_allocations').all() as DbPortAllocation[];

  const cleanup = db.transaction(() => {
    for (const alloc of allocations) {
      // Remove if project doesn't exist
      if (!projectExists(alloc.project_path)) {
        removed.push(alloc.project_path);
        db.prepare('DELETE FROM port_allocations WHERE project_path = ?').run(alloc.project_path);
        continue;
      }

      // Clear PID if process is stale (process no longer running)
      // Don't remove the entry, just clear the PID - project still exists
      if (alloc.pid && !isProcessAlive(alloc.pid)) {
        db.prepare('UPDATE port_allocations SET pid = NULL WHERE project_path = ?').run(alloc.project_path);
      }
    }
  });

  cleanup();

  const remaining = db.prepare('SELECT COUNT(*) as count FROM port_allocations').get() as { count: number };

  return {
    removed,
    remaining: remaining.count,
  };
}

/**
 * Get or allocate a port block for a project
 * Returns the base port for the project's block
 * Note: This function is now synchronous and uses BEGIN IMMEDIATE for atomicity
 */
export function getPortBlock(projectRoot: string): number {
  // Normalize path for consistent keys
  const normalizedPath = resolve(projectRoot);

  const db = getGlobalDb();

  // Use immediate transaction to prevent race conditions
  const allocate = db.transaction(() => {
    // Check if project already has an allocation
    const existing = db.prepare('SELECT * FROM port_allocations WHERE project_path = ?')
      .get(normalizedPath) as DbPortAllocation | undefined;

    if (existing) {
      // Update last used timestamp and PID
      db.prepare(`
        UPDATE port_allocations
        SET last_used_at = datetime('now'), pid = ?
        WHERE project_path = ?
      `).run(process.pid, normalizedPath);

      return existing.base_port;
    }

    // Find next available port block (with gap recycling)
    // Get all allocated ports as a Set for O(1) lookup
    const allocated = new Set(
      (db.prepare('SELECT base_port FROM port_allocations').all() as { base_port: number }[])
        .map(row => row.base_port)
    );

    // Find the first available port starting from BASE_PORT
    let nextPort = BASE_PORT;
    const maxPossiblePort = BASE_PORT + (MAX_ALLOCATIONS * PORT_BLOCK_SIZE);

    while (nextPort < maxPossiblePort) {
      // Skip if already allocated or blocked
      if (!allocated.has(nextPort) && !BLOCKED_PORT_BLOCKS.includes(nextPort)) {
        break;
      }
      nextPort += PORT_BLOCK_SIZE;
    }

    // Ensure we found an available port
    if (nextPort >= maxPossiblePort) {
      throw new Error('No available port blocks. Maximum allocations reached.');
    }

    // Insert new allocation
    db.prepare(`
      INSERT INTO port_allocations (project_path, base_port, pid)
      VALUES (?, ?, ?)
    `).run(normalizedPath, nextPort, process.pid);

    return nextPort;
  });

  // Use immediate() to serialize with other writers
  return allocate.immediate();
}

/**
 * Get port configuration for a project
 * Returns all port assignments based on the project's base port
 */
export interface ProjectPorts {
  basePort: number;
  dashboardPort: number;
  architectPort: number;
  builderPortRange: [number, number];
  utilPortRange: [number, number];
  openPortRange: [number, number];
}

export function getProjectPorts(projectRoot: string): ProjectPorts {
  const basePort = getPortBlock(projectRoot);

  return {
    basePort,
    dashboardPort: basePort,           // 4200
    architectPort: basePort + 1,        // 4201
    builderPortRange: [basePort + 10, basePort + 29] as [number, number],  // 4210-4229
    utilPortRange: [basePort + 30, basePort + 49] as [number, number],     // 4230-4249
    openPortRange: [basePort + 50, basePort + 69] as [number, number], // 4250-4269
  };
}

/**
 * List all registered projects and their port blocks
 */
export function listAllocations(): Array<{
  path: string;
  basePort: number;
  registered: string;
  lastUsed?: string;
  exists: boolean;
  pid?: number;
  pidAlive?: boolean;
}> {
  const db = getGlobalDb();
  const allocations = db.prepare('SELECT * FROM port_allocations ORDER BY base_port').all() as DbPortAllocation[];

  return allocations.map((alloc) => ({
    path: alloc.project_path,
    basePort: alloc.base_port,
    registered: alloc.registered_at,
    lastUsed: alloc.last_used_at,
    exists: projectExists(alloc.project_path),
    pid: alloc.pid ?? undefined,
    pidAlive: alloc.pid ? isProcessAlive(alloc.pid) : undefined,
  }));
}

/**
 * Remove a project's port allocation
 * Note: This function is now synchronous
 */
export function removeAllocation(projectRoot: string): boolean {
  const normalizedPath = resolve(projectRoot);
  const db = getGlobalDb();

  const result = db.prepare('DELETE FROM port_allocations WHERE project_path = ?').run(normalizedPath);

  return result.changes > 0;
}

// Re-export closeGlobalDb for cleanup
export { closeGlobalDb };
