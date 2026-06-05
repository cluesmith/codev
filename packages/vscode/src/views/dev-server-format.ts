/**
 * Pure formatting helpers for the Codev Dev surface (#921): the panel tab's
 * status header and the status-bar chip. Kept free of `vscode` imports so they
 * unit-test in plain node (vitest).
 */

/**
 * Human-readable elapsed time for the "Running for ..." row, from a millisecond
 * duration. `4m 32s`, `1h 05m`, `0s`. Negative durations (clock skew, a
 * start-time read after the stop) clamp to `0s` rather than render nonsense.
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/**
 * Friendly display name for a dev target id shown in the chip and status header.
 * The dev-slot id is normally already friendly (`main`, or a worktree basename
 * like `pir-809`), but a canonical role id (`builder-pir-809`) can reach here;
 * strip that prefix so the surface never shows `builder-…`. Anything else passes
 * through unchanged.
 */
export function formatTargetName(builderId: string): string {
  return builderId.startsWith('builder-') ? builderId.slice('builder-'.length) : builderId;
}

/** Minimal view of the worktree config this module reads — see ResolvedWorktreeConfig. */
export interface DevPortSource {
  devCommand?: string | null;
  devUrls?: Array<{ url: string }>;
}

/**
 * Best-effort port for the status header. The dev PTY does not report its port,
 * so we infer it from config only: first a `devUrls` entry's URL, then a port
 * mentioned in the `devCommand` (`--port 3000`, `-p 3000`, `PORT=3000`, or a
 * bare `:3000`). Returns null when nothing is derivable — the caller omits the
 * row rather than guess.
 */
export function extractDevPort(config: DevPortSource | null | undefined): number | null {
  if (!config) { return null; }

  for (const { url } of config.devUrls ?? []) {
    const port = portFromUrl(url);
    if (port !== null) { return port; }
  }

  const cmd = config.devCommand ?? '';
  const match = cmd.match(/(?:--port[ =]|-p\s+|PORT=|:)(\d{2,5})\b/);
  if (match) {
    const port = Number(match[1]);
    if (isValidPort(port)) { return port; }
  }

  return null;
}

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const port = Number(parsed.port);
      return isValidPort(port) ? port : null;
    }
  } catch {
    // not a parseable URL — ignore
  }
  return null;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
