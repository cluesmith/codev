/**
 * Ruler integration utilities
 * https://github.com/intellectronica/ruler
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Detect if project uses Ruler for agent config management
 */
export function detectRuler(targetDir: string): boolean {
  const rulerToml = path.join(targetDir, '.ruler', 'ruler.toml');
  return fs.existsSync(rulerToml);
}
