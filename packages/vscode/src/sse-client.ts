import * as vscode from 'vscode';

export type SSEListener = (eventType: string, data: string) => void;

/**
 * SSE client for Tower's /api/events endpoint.
 *
 * Filters heartbeats and dispatches every other event to listeners.
 * Throttling, if needed, is the consumer's responsibility (e.g. the
 * overview cache self-throttles via its `loading` guard) — coalescing
 * here would silently drop payload-carrying events like `builder-spawned`.
 */
export class SSEClient {
  private eventSource: EventSource | null = null;
  private listeners: SSEListener[] = [];
  private disposed = false;

  constructor(
    private baseUrl: string,
    private outputChannel: vscode.OutputChannel,
    private onDisconnect: () => void,
  ) {}

  /**
   * Connect to Tower SSE endpoint.
   */
  connect(): void {
    if (this.disposed) { return; }
    this.disconnect();

    const url = `${this.baseUrl}/api/events`;
    this.log('INFO', `SSE connecting to ${url}`);

    // Use fetch-based SSE since Node.js EventSource may not be available
    this.startSSE(url);
  }

  /**
   * Register a listener for SSE events.
   */
  onEvent(listener: SSEListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) { this.listeners.splice(idx, 1); }
    });
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners = [];
  }

  private async startSSE(url: string): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'text/event-stream' },
      });

      if (!response.ok || !response.body) {
        this.log('WARN', `SSE connection failed: ${response.status}`);
        this.onDisconnect();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const read = async (): Promise<void> => {
        if (this.disposed) { return; }

        try {
          const { done, value } = await reader.read();
          if (done) {
            this.log('INFO', 'SSE stream ended');
            this.onDisconnect();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete last line

          let currentEvent = '';
          let currentData = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData = line.slice(5).trim();
            } else if (line === '') {
              // Empty line = event boundary
              if (currentEvent || currentData) {
                this.handleEvent(currentEvent, currentData);
                currentEvent = '';
                currentData = '';
              }
            }
          }

          // Continue reading
          await read();
        } catch (err) {
          if (!this.disposed) {
            this.log('ERROR', `SSE read error: ${(err as Error).message}`);
            this.onDisconnect();
          }
        }
      };

      await read();
    } catch (err) {
      if (!this.disposed) {
        this.log('ERROR', `SSE connection error: ${(err as Error).message}`);
        this.onDisconnect();
      }
    }
  }

  private handleEvent(eventType: string, data: string): void {
    if (eventType === 'heartbeat' || eventType === 'ping') {
      return;
    }
    this.dispatch(eventType, data);
  }

  private dispatch(eventType: string, data: string): void {
    for (const listener of this.listeners) {
      try {
        listener(eventType, data);
      } catch (err) {
        this.log('ERROR', `SSE listener error: ${(err as Error).message}`);
      }
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [SSE] [${level}] ${message}`);
  }
}
