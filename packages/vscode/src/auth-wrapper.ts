import * as vscode from 'vscode';
import { readLocalKey } from '@cluesmith/codev-core/auth';

const SECRET_KEY = 'codev-local-key';

/**
 * Wraps the shared readLocalKey() with VS Code SecretStorage caching.
 * Re-reads from disk on 401 to handle key rotation.
 */
export class AuthWrapper {
  private secretStorage: vscode.SecretStorage;
  private cachedKey: string | null = null;

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  /**
   * Get the auth key. Returns from cache, SecretStorage, or disk (in that order).
   */
  async getKey(): Promise<string | null> {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    const stored = await this.secretStorage.get(SECRET_KEY);
    if (stored) {
      this.cachedKey = stored;
      return stored;
    }

    return this.readFromDisk();
  }

  /**
   * Force re-read from disk. Called on 401 to handle key rotation.
   */
  async refreshKey(): Promise<string | null> {
    this.cachedKey = null;
    await this.secretStorage.delete(SECRET_KEY);
    return this.readFromDisk();
  }

  /**
   * Get auth key synchronously for TowerClient's getAuthKey callback.
   * Returns cached value or reads from disk. SecretStorage is async
   * so we prime the cache during initialization.
   */
  getKeySync(): string | null {
    if (this.cachedKey) {
      return this.cachedKey;
    }
    // Fallback to direct disk read if cache not primed
    const key = readLocalKey();
    if (key) {
      this.cachedKey = key;
    }
    return key;
  }

  /**
   * Prime the cache from SecretStorage or disk. Call during initialization.
   */
  async initialize(): Promise<void> {
    await this.getKey();
  }

  private async readFromDisk(): Promise<string | null> {
    const key = readLocalKey();
    if (key) {
      this.cachedKey = key;
      await this.secretStorage.store(SECRET_KEY, key);
    }
    return key;
  }
}
