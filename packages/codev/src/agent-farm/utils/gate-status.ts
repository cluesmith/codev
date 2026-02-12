/**
 * Gate status reader for porch YAML files.
 * Extracts pending gate information from codev/projects/<id>/status.yaml.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface GateStatus {
  hasGate: boolean;
  gateName?: string;
  builderId?: string;
  timestamp?: number;
}

/**
 * Read gate status from porch YAML files for a project.
 * Scans codev/projects/<id>/status.yaml for gates with status: pending.
 */
export function getGateStatusForProject(projectPath: string): GateStatus {
  try {
    const projectsDir = path.join(projectPath, 'codev', 'projects');
    if (!fs.existsSync(projectsDir)) {
      return { hasGate: false };
    }

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const statusFile = path.join(projectsDir, entry.name, 'status.yaml');
      if (!fs.existsSync(statusFile)) continue;

      const content = fs.readFileSync(statusFile, 'utf-8');

      // Simple YAML parsing: look for pending gates
      // Format:
      //   gates:
      //     spec-approval:
      //       status: pending
      const gatesMatch = content.match(/^gates:\s*$/m);
      if (!gatesMatch) continue;

      const gatesSection = content.slice(gatesMatch.index! + gatesMatch[0].length);
      const lines = gatesSection.split('\n');

      let currentGate = '';
      for (const line of lines) {
        // Stop at next top-level key
        if (/^\S/.test(line) && line.trim() !== '') break;

        const gateNameMatch = line.match(/^\s{2}(\S+):\s*$/);
        if (gateNameMatch) {
          currentGate = gateNameMatch[1];
          continue;
        }

        const statusMatch = line.match(/^\s{4}status:\s*(\S+)/);
        if (statusMatch && currentGate) {
          if (statusMatch[1] === 'pending') {
            // Extract builder ID from directory name (e.g., "0099-tower-hygiene" -> "0099")
            const builderId = entry.name.match(/^(\d+)/)?.[1] || entry.name;
            return {
              hasGate: true,
              gateName: currentGate,
              builderId,
            };
          }
        }
      }
    }
  } catch {
    // Silently return no gate on errors (logged at call site if needed)
  }

  return { hasGate: false };
}
