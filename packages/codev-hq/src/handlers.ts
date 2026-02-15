/**
 * WebSocket message handlers for CODEV_HQ
 */

import type { WebSocket } from 'ws';
import { state } from './state.js';
import type {
  Message,
  Response,
  RegisterPayload,
  StatusUpdatePayload,
  BuilderUpdatePayload,
  GateCompletedPayload,
  PingPayload,
  ApprovalPayload,
} from './types.js';

// Generate unique message ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Create response message
function createResponse(
  requestId: string,
  success: boolean,
  payload?: Record<string, unknown>,
  error?: string
): Response {
  return {
    type: 'response',
    id: requestId,
    ts: Date.now(),
    success,
    payload,
    error,
  };
}

// Send message to client
export function sendMessage(ws: WebSocket, message: Message | Response): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Handle incoming message
export function handleMessage(ws: WebSocket, data: string): void {
  let message: Message;

  try {
    message = JSON.parse(data);
  } catch {
    sendMessage(ws, createResponse('unknown', false, undefined, 'Invalid JSON'));
    return;
  }

  if (!message.type || !message.id) {
    sendMessage(ws, createResponse(message.id || 'unknown', false, undefined, 'Missing type or id'));
    return;
  }

  const handler = messageHandlers[message.type];
  if (!handler) {
    sendMessage(ws, createResponse(message.id, false, undefined, `Unknown message type: ${message.type}`));
    return;
  }

  try {
    handler(ws, message);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    sendMessage(ws, createResponse(message.id, false, undefined, errorMessage));
  }
}

// Message handlers by type
const messageHandlers: Record<string, (ws: WebSocket, message: Message) => void> = {
  // Handle registration
  register(ws, message) {
    const payload = message.payload as unknown as RegisterPayload;

    if (!payload.instance_id) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Missing instance_id'));
      return;
    }

    const instance = state.registerInstance(
      ws,
      payload.instance_id,
      payload.instance_name,
      payload.version,
      payload.workspaces || []
    );

    console.log(`[HQ] Instance registered: ${payload.instance_id} (${payload.instance_name || 'unnamed'})`);
    console.log(`[HQ]   Workspaces: ${payload.workspaces?.map(w => w.name).join(', ') || 'none'}`);

    sendMessage(ws, createResponse(message.id, true, {
      session_id: payload.instance_id,
      server_time: Date.now(),
    }));
  },

  // Handle ping (heartbeat)
  ping(ws, message) {
    const instance = state.getInstanceByWs(ws);
    if (instance) {
      state.updatePing(instance.instance_id);
    }

    const payload = message.payload as unknown as PingPayload;
    sendMessage(ws, {
      type: 'pong',
      id: generateId(),
      ts: Date.now(),
      payload: { ts: payload.ts },
    });
  },

  // Handle status file update
  status_update(ws, message) {
    const instance = state.getInstanceByWs(ws);
    if (!instance) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Not registered'));
      return;
    }

    const payload = message.payload as unknown as StatusUpdatePayload;

    if (!payload.workspace_path || !payload.status_file || !payload.content) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Missing required fields'));
      return;
    }

    state.updateStatusFile(
      instance.instance_id,
      payload.workspace_path,
      payload.status_file,
      payload.content,
      payload.git_sha
    );

    console.log(`[HQ] Status updated: ${payload.status_file} from ${instance.instance_name || instance.instance_id}`);

    sendMessage(ws, createResponse(message.id, true));
  },

  // Handle builder status update
  builder_update(ws, message) {
    const instance = state.getInstanceByWs(ws);
    if (!instance) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Not registered'));
      return;
    }

    const payload = message.payload as unknown as BuilderUpdatePayload;

    if (!payload.workspace_path || !payload.builder_id || !payload.status) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Missing required fields'));
      return;
    }

    state.updateBuilder(
      instance.instance_id,
      payload.workspace_path,
      payload.builder_id,
      payload.status,
      payload.phase,
      payload.branch
    );

    console.log(`[HQ] Builder ${payload.builder_id} status: ${payload.status}`);

    sendMessage(ws, createResponse(message.id, true));
  },

  // Handle gate completed notification
  gate_completed(ws, message) {
    const instance = state.getInstanceByWs(ws);
    if (!instance) {
      sendMessage(ws, createResponse(message.id, false, undefined, 'Not registered'));
      return;
    }

    const payload = message.payload as unknown as GateCompletedPayload;
    console.log(`[HQ] Gate completed: ${payload.gate} for project ${payload.project_id}`);

    sendMessage(ws, createResponse(message.id, true));
  },
};

// Send approval to a specific instance
export function sendApproval(
  instance_id: string,
  approval: ApprovalPayload
): boolean {
  const instance = state.getInstance(instance_id);
  if (!instance) {
    console.error(`[HQ] Cannot send approval: instance ${instance_id} not found`);
    return false;
  }

  // Get the WebSocket from our state (we need to cast since ConnectedInstance doesn't expose ws)
  const instances = state.getAllInstances();
  const fullInstance = instances.find(i => i.instance_id === instance_id);
  if (!fullInstance) {
    return false;
  }

  // We need to access the ws through state - let's add a helper
  const ws = (state as any).instances.get(instance_id)?.ws as WebSocket | undefined;
  if (!ws || ws.readyState !== ws.OPEN) {
    console.error(`[HQ] Cannot send approval: WebSocket not open`);
    return false;
  }

  const message: Message = {
    type: 'approval',
    id: generateId(),
    ts: Date.now(),
    payload: approval as unknown as Record<string, unknown>,
  };

  sendMessage(ws, message);
  console.log(`[HQ] Sent approval for ${approval.gate} to ${instance_id}`);
  return true;
}
