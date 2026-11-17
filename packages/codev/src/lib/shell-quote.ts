/**
 * Shell quoting shared by the launch-script writers (harness fragments, the
 * builder launch script, lifecycle reporting) and the Windows command launch
 * capability. A leaf module (no imports).
 */

/**
 * Escape a string for safe inclusion inside single quotes in bash.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}
