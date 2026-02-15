import { useState, useEffect, useCallback } from 'react';

// Types matching HQ server
interface WorkspaceInfo {
  path: string;
  name: string;
  git_remote?: string;
}

interface StatusFile {
  path: string;
  content: string;
  git_sha?: string;
}

interface BuilderInfo {
  builder_id: string;
  status: 'spawning' | 'implementing' | 'blocked' | 'pr-ready' | 'complete';
  phase?: string;
  branch?: string;
}

interface InstanceData {
  instance_id: string;
  instance_name?: string;
  version?: string;
  connected_at: string;
  last_ping: string;
  workspaces: WorkspaceInfo[];
  status_files: StatusFile[];
  builders: BuilderInfo[];
}

interface StateSnapshot {
  instances: InstanceData[];
  timestamp: string;
}

// Parse gates from status file YAML frontmatter
function parseGates(content: string): Record<string, { status: string; by?: string; at?: string }> {
  const gates: Record<string, { status: string; by?: string; at?: string }> = {};

  // Simple regex parsing of YAML frontmatter
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!yamlMatch) return gates;

  const yaml = yamlMatch[1];

  // Find gates section and parse each gate
  const gatesMatch = yaml.match(/gates:\s*\n([\s\S]*?)(?=\n\w|\n---|\z)/);
  if (!gatesMatch) return gates;

  const gatesSection = gatesMatch[1];
  const gateRegex = /(\w+):\s*\{([^}]+)\}/g;
  let match;

  while ((match = gateRegex.exec(gatesSection)) !== null) {
    const gateName = match[1];
    const gateContent = match[2];

    const statusMatch = gateContent.match(/status:\s*(\w+)/);
    const byMatch = gateContent.match(/by:\s*(\w+)/);
    const atMatch = gateContent.match(/at:\s*([^,}]+)/);

    if (statusMatch) {
      gates[gateName] = {
        status: statusMatch[1],
        by: byMatch?.[1],
        at: atMatch?.[1]?.trim(),
      };
    }
  }

  return gates;
}

// Status badge component
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: '#f59e0b',
    passed: '#22c55e',
    failed: '#ef4444',
    spawning: '#f59e0b',
    implementing: '#3b82f6',
    blocked: '#ef4444',
    'pr-ready': '#22c55e',
    complete: '#6b7280',
  };

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 500,
        backgroundColor: `${colors[status] || '#6b7280'}20`,
        color: colors[status] || '#6b7280',
        border: `1px solid ${colors[status] || '#6b7280'}40`,
      }}
    >
      {status}
    </span>
  );
}

// Main App
export default function App() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setWs] = useState<WebSocket | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  // Fetch initial state
  const fetchState = useCallback(async () => {
    try {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch state');
    }
  }, []);

  // Connect WebSocket for real-time updates
  useEffect(() => {
    fetchState();

    // Connect to WebSocket for state events
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

    socket.onmessage = () => {
      // Re-fetch state on any message (simple approach for spike)
      fetchState();
    };

    socket.onclose = () => {
      console.log('WebSocket closed, reconnecting...');
      setTimeout(() => setWs(null), 3000);
    };

    setWs(socket);

    // Polling fallback for state updates
    const interval = setInterval(fetchState, 5000);

    return () => {
      socket.close();
      clearInterval(interval);
    };
  }, [fetchState]);

  // Handle approval click
  const handleApprove = async (
    instance_id: string,
    workspace_path: string,
    project_id: string,
    gate: string
  ) => {
    const key = `${instance_id}:${gate}`;
    setApproving(key);

    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instance_id,
          workspace_path,
          project_id,
          gate,
          approved_by: 'dashboard-user',
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Refresh state
      await fetchState();
    } catch (err) {
      alert(`Approval failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setApproving(null);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <header style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>
          CODEV_HQ
        </h1>
        <p style={{ color: '#a1a1aa', fontSize: '14px' }}>
          Cloud Control Plane for Agent Farm (Spike)
        </p>
        {state && (
          <p style={{ color: '#6b7280', fontSize: '12px', marginTop: '4px' }}>
            Last updated: {new Date(state.timestamp).toLocaleTimeString()}
          </p>
        )}
      </header>

      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '16px',
            marginBottom: '24px',
            backgroundColor: '#ef444420',
            border: '1px solid #ef444440',
            borderRadius: '8px',
            color: '#ef4444',
          }}
        >
          Error: {error}
        </div>
      )}

      {/* No instances */}
      {state?.instances.length === 0 && (
        <div
          style={{
            padding: '48px',
            textAlign: 'center',
            backgroundColor: '#12121a',
            borderRadius: '12px',
            border: '1px solid #27272a',
          }}
        >
          <h2 style={{ fontSize: '18px', marginBottom: '8px' }}>No Instances Connected</h2>
          <p style={{ color: '#a1a1aa', marginBottom: '24px' }}>
            Start Agent Farm with CODEV_HQ_URL to connect:
          </p>
          <code
            style={{
              display: 'block',
              padding: '12px',
              backgroundColor: '#0a0a0f',
              borderRadius: '6px',
              fontSize: '14px',
              fontFamily: 'monospace',
            }}
          >
            export CODEV_HQ_URL="ws://localhost:4300/ws"
            <br />
            af start
          </code>
        </div>
      )}

      {/* Connected instances */}
      {state?.instances.map((instance) => (
        <div
          key={instance.instance_id}
          style={{
            marginBottom: '24px',
            padding: '24px',
            backgroundColor: '#12121a',
            borderRadius: '12px',
            border: '1px solid #27272a',
          }}
        >
          {/* Instance header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '16px',
            }}
          >
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 600 }}>
                {instance.instance_name || instance.instance_id.substring(0, 8)}
              </h2>
              <p style={{ color: '#6b7280', fontSize: '12px' }}>
                v{instance.version} · Connected {new Date(instance.connected_at).toLocaleTimeString()}
              </p>
            </div>
            <div
              style={{
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: '#22c55e',
              }}
              title="Connected"
            />
          </div>

          {/* Workspaces */}
          {instance.workspaces.map((workspace) => (
            <div
              key={workspace.path}
              style={{
                marginBottom: '16px',
                padding: '16px',
                backgroundColor: '#1a1a24',
                borderRadius: '8px',
              }}
            >
              <h3 style={{ fontSize: '16px', fontWeight: 500, marginBottom: '12px' }}>
                {workspace.name}
              </h3>

              {/* Builders */}
              {instance.builders.length > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <h4
                    style={{
                      fontSize: '12px',
                      color: '#a1a1aa',
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Builders
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {instance.builders.map((builder) => (
                      <div
                        key={builder.builder_id}
                        style={{
                          padding: '8px 12px',
                          backgroundColor: '#0a0a0f',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <span style={{ fontFamily: 'monospace' }}>{builder.builder_id}</span>
                        <StatusBadge status={builder.status} />
                        {builder.phase && (
                          <span style={{ color: '#6b7280', fontSize: '12px' }}>
                            {builder.phase}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Status files / Gates */}
              {instance.status_files.length > 0 && (
                <div>
                  <h4
                    style={{
                      fontSize: '12px',
                      color: '#a1a1aa',
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Status Files
                  </h4>
                  {instance.status_files.map((file) => {
                    const gates = parseGates(file.content);
                    const pendingGates = Object.entries(gates).filter(
                      ([, g]) => g.status === 'pending'
                    );
                    const passedGates = Object.entries(gates).filter(
                      ([, g]) => g.status === 'passed'
                    );

                    // Extract project_id from filename (e.g., "0068-name.md" -> "0068")
                    const project_id = file.path.match(/(\d+)-/)?.[1] || '';

                    return (
                      <div
                        key={file.path}
                        style={{
                          padding: '12px',
                          backgroundColor: '#0a0a0f',
                          borderRadius: '6px',
                          marginBottom: '8px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '8px',
                          }}
                        >
                          <span style={{ fontFamily: 'monospace', fontSize: '14px' }}>
                            {file.path}
                          </span>
                          {file.git_sha && (
                            <span style={{ color: '#6b7280', fontSize: '11px' }}>
                              {file.git_sha.substring(0, 7)}
                            </span>
                          )}
                        </div>

                        {/* Pending gates with approve button */}
                        {pendingGates.length > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <h5 style={{ fontSize: '11px', color: '#f59e0b', marginBottom: '8px' }}>
                              Pending Approval
                            </h5>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                              {pendingGates.map(([gateName]) => {
                                const key = `${instance.instance_id}:${gateName}`;
                                const isApproving = approving === key;

                                return (
                                  <button
                                    key={gateName}
                                    onClick={() =>
                                      handleApprove(
                                        instance.instance_id,
                                        workspace.path,
                                        project_id,
                                        gateName
                                      )
                                    }
                                    disabled={isApproving}
                                    style={{
                                      padding: '8px 16px',
                                      backgroundColor: isApproving ? '#27272a' : '#3b82f6',
                                      color: isApproving ? '#6b7280' : '#ffffff',
                                      border: 'none',
                                      borderRadius: '6px',
                                      cursor: isApproving ? 'not-allowed' : 'pointer',
                                      fontSize: '13px',
                                      fontWeight: 500,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                    }}
                                  >
                                    {isApproving ? (
                                      'Approving...'
                                    ) : (
                                      <>
                                        <span>Approve</span>
                                        <span style={{ fontFamily: 'monospace' }}>{gateName}</span>
                                      </>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Passed gates */}
                        {passedGates.length > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <h5 style={{ fontSize: '11px', color: '#22c55e', marginBottom: '8px' }}>
                              Passed
                            </h5>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                              {passedGates.map(([gateName, gate]) => (
                                <div
                                  key={gateName}
                                  style={{
                                    padding: '4px 8px',
                                    backgroundColor: '#22c55e20',
                                    border: '1px solid #22c55e40',
                                    borderRadius: '4px',
                                    fontSize: '12px',
                                  }}
                                  title={`Approved by ${gate.by} at ${gate.at}`}
                                >
                                  {gateName}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {/* Footer */}
      <footer
        style={{
          marginTop: '48px',
          padding: '16px',
          borderTop: '1px solid #27272a',
          textAlign: 'center',
          color: '#6b7280',
          fontSize: '12px',
        }}
      >
        CODEV_HQ Spike · Part of <a href="https://github.com/cluesmith/codev" style={{ color: '#3b82f6' }}>Codev</a>
      </footer>
    </div>
  );
}
