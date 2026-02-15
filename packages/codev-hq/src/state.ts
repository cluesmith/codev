/**
 * In-memory state management for CODEV_HQ (spike)
 * Production would use PostgreSQL
 */

import type { WebSocket } from 'ws';
import type {
  ConnectedInstance,
  WorkspaceInfo,
  StatusFile,
  BuilderInfo,
} from './types.js';

// Instance state with WebSocket connection
interface InstanceConnection extends ConnectedInstance {
  ws: WebSocket;
}

class HQState {
  // Map of instance_id -> connection info
  private instances: Map<string, InstanceConnection> = new Map();

  // Listeners for state changes (dashboard will subscribe)
  private listeners: Set<(event: StateEvent) => void> = new Set();

  registerInstance(
    ws: WebSocket,
    instance_id: string,
    instance_name?: string,
    version?: string,
    workspaces: WorkspaceInfo[] = []
  ): ConnectedInstance {
    const instance: InstanceConnection = {
      ws,
      instance_id,
      instance_name,
      version,
      connected_at: new Date(),
      last_ping: new Date(),
      workspaces,
      status_files: new Map(),
      builders: new Map(),
    };

    this.instances.set(instance_id, instance);
    this.emit({ type: 'instance_connected', instance_id, instance_name, workspaces });
    return instance;
  }

  unregisterInstance(instance_id: string): void {
    const instance = this.instances.get(instance_id);
    if (instance) {
      this.instances.delete(instance_id);
      this.emit({ type: 'instance_disconnected', instance_id });
    }
  }

  getInstance(instance_id: string): ConnectedInstance | undefined {
    return this.instances.get(instance_id);
  }

  getInstanceByWs(ws: WebSocket): InstanceConnection | undefined {
    for (const instance of this.instances.values()) {
      if (instance.ws === ws) {
        return instance;
      }
    }
    return undefined;
  }

  getAllInstances(): ConnectedInstance[] {
    return Array.from(this.instances.values());
  }

  updatePing(instance_id: string): void {
    const instance = this.instances.get(instance_id);
    if (instance) {
      instance.last_ping = new Date();
    }
  }

  updateStatusFile(
    instance_id: string,
    workspace_path: string,
    status_file: string,
    content: string,
    git_sha?: string
  ): void {
    const instance = this.instances.get(instance_id);
    if (!instance) return;

    const file: StatusFile = { path: status_file, content, git_sha };
    instance.status_files.set(`${workspace_path}:${status_file}`, file);

    this.emit({
      type: 'status_updated',
      instance_id,
      workspace_path,
      status_file,
      content,
    });
  }

  updateBuilder(
    instance_id: string,
    workspace_path: string,
    builder_id: string,
    status: BuilderInfo['status'],
    phase?: string,
    branch?: string
  ): void {
    const instance = this.instances.get(instance_id);
    if (!instance) return;

    const builder: BuilderInfo = { builder_id, status, phase, branch };
    instance.builders.set(`${workspace_path}:${builder_id}`, builder);

    this.emit({
      type: 'builder_updated',
      instance_id,
      workspace_path,
      builder_id,
      status,
    });
  }

  // Get all status files across all instances for a given workspace path pattern
  getStatusFilesByWorkspace(workspace_path: string): Array<{ instance_id: string; file: StatusFile }> {
    const results: Array<{ instance_id: string; file: StatusFile }> = [];

    for (const [instance_id, instance] of this.instances) {
      for (const [key, file] of instance.status_files) {
        if (key.startsWith(workspace_path)) {
          results.push({ instance_id, file });
        }
      }
    }

    return results;
  }

  // Subscribe to state changes
  subscribe(listener: (event: StateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('State listener error:', error);
      }
    }
  }

  // Get full state snapshot for dashboard
  getSnapshot(): StateSnapshot {
    const instances: StateSnapshot['instances'] = [];

    for (const [instance_id, instance] of this.instances) {
      instances.push({
        instance_id,
        instance_name: instance.instance_name,
        version: instance.version,
        connected_at: instance.connected_at.toISOString(),
        last_ping: instance.last_ping.toISOString(),
        workspaces: instance.workspaces,
        status_files: Array.from(instance.status_files.values()),
        builders: Array.from(instance.builders.values()),
      });
    }

    return { instances, timestamp: new Date().toISOString() };
  }
}

// Event types emitted on state changes
export type StateEvent =
  | { type: 'instance_connected'; instance_id: string; instance_name?: string; workspaces: WorkspaceInfo[] }
  | { type: 'instance_disconnected'; instance_id: string }
  | { type: 'status_updated'; instance_id: string; workspace_path: string; status_file: string; content: string }
  | { type: 'builder_updated'; instance_id: string; workspace_path: string; builder_id: string; status: string };

// Snapshot of full state
export interface StateSnapshot {
  instances: Array<{
    instance_id: string;
    instance_name?: string;
    version?: string;
    connected_at: string;
    last_ping: string;
    workspaces: WorkspaceInfo[];
    status_files: StatusFile[];
    builders: BuilderInfo[];
  }>;
  timestamp: string;
}

// Singleton instance
export const state = new HQState();
