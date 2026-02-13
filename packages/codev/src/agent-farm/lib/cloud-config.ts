/**
 * Cloud Config Management (Spec 0097 Phase 1)
 *
 * Reads, writes, and validates ~/.agent-farm/cloud-config.json
 * for tower registration with codevos.ai.
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');
const CLOUD_CONFIG_FILENAME = 'cloud-config.json';
const MACHINE_ID_FILENAME = 'machine-id';

/**
 * Cloud configuration stored after tower registration with codevos.ai.
 */
export interface CloudConfig {
  tower_id: string;
  tower_name: string;
  api_key: string;
  server_url: string;
}

const REQUIRED_FIELDS: (keyof CloudConfig)[] = [
  'tower_id',
  'tower_name',
  'api_key',
  'server_url',
];

/**
 * Returns the path to ~/.agent-farm/cloud-config.json
 */
export function getCloudConfigPath(): string {
  return resolve(AGENT_FARM_DIR, CLOUD_CONFIG_FILENAME);
}

/**
 * Read and validate the cloud config file.
 *
 * - Returns null if the file does not exist.
 * - Throws if the file contains invalid JSON.
 * - Returns null (with console.warn) if required fields are missing.
 */
export function readCloudConfig(): CloudConfig | null {
  const configPath = getCloudConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Cloud config at ${configPath} contains invalid JSON. Delete it and re-register with 'af tower register'.`
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cloud config at ${configPath} contains invalid JSON. Expected an object.`
    );
  }

  const config = parsed as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter(
    (field) => typeof config[field] !== 'string' || config[field] === ''
  );

  if (missing.length > 0) {
    console.warn(
      `Cloud config at ${configPath} is missing required fields: ${missing.join(', ')}. ` +
        `Tower will operate in local-only mode. Fix with 'af tower register'.`
    );
    return null;
  }

  return {
    tower_id: config.tower_id as string,
    tower_name: config.tower_name as string,
    api_key: config.api_key as string,
    server_url: config.server_url as string,
  };
}

/**
 * Write cloud config to disk with 0600 permissions.
 * Creates the parent directory if needed.
 */
export function writeCloudConfig(config: CloudConfig): void {
  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  const configPath = getCloudConfigPath();
  const json = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(configPath, json, { mode: 0o600 });
  // Enforce 0600 even if the file already existed with different permissions
  chmodSync(configPath, 0o600);
}

/**
 * Delete the cloud config file. No-op if it doesn't exist.
 */
export function deleteCloudConfig(): void {
  const configPath = getCloudConfigPath();
  if (existsSync(configPath)) {
    unlinkSync(configPath);
  }
}

/**
 * Returns true if a valid cloud config exists.
 */
export function isRegistered(): boolean {
  return readCloudConfig() !== null;
}

/**
 * Returns the path to ~/.agent-farm/machine-id
 */
export function getMachineIdPath(): string {
  return resolve(AGENT_FARM_DIR, MACHINE_ID_FILENAME);
}

/**
 * Get or create a persistent machine ID (UUID v4).
 *
 * Reads from ~/.agent-farm/machine-id if it exists.
 * Otherwise generates a new UUID, persists it, and returns it.
 * This ID survives tower deregistration and re-registration.
 */
export function getOrCreateMachineId(): string {
  const machineIdPath = getMachineIdPath();

  if (existsSync(machineIdPath)) {
    const id = readFileSync(machineIdPath, 'utf-8').trim();
    if (id) return id;
  }

  const id = randomUUID();

  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  writeFileSync(machineIdPath, id + '\n', { mode: 0o600 });
  return id;
}

/**
 * Mask an API key for logging, showing only the prefix and last 4 chars.
 * Example: "ctk_AbCdEfGhIjKl1234" → "ctk_****1234"
 */
export function maskApiKey(key: string): string {
  const prefixEnd = key.indexOf('_');
  if (prefixEnd === -1 || key.length < prefixEnd + 5) {
    // No prefix or too short — just show last 4
    if (key.length <= 4) return '****';
    return '****' + key.slice(-4);
  }
  const prefix = key.slice(0, prefixEnd + 1); // e.g. "ctk_"
  const last4 = key.slice(-4);
  return `${prefix}****${last4}`;
}
