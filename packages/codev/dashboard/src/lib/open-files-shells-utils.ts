/** Format milliseconds as compact relative duration: "<1m", "1m", "5m", "1h", "2d" */
export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Extract a display-friendly short path: parent/basename */
export function shortPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 1) return filePath;
  return parts.slice(-2).join('/');
}
