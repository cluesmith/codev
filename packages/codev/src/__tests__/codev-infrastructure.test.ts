/**
 * #1915: recognizing a Tower or a shellper in a session job, so teardown and the
 * orphan listing never end one. Pure functions; runs on every platform.
 */

import { describe, it, expect } from 'vitest';
import { isCodevInfrastructure, protectedInfrastructure } from '../lib/platform/windows/codev-infrastructure.js';
import { SHELLPER_MARKER } from '../terminal/shellper-cmdline.js';
import type { ProcessCensusEntry } from '../lib/platform/processes.js';

function entry(pid: number, ppid: number, cmdline: string, creationTime = pid * 10): ProcessCensusEntry {
  return { pid, ppid, rssKb: 0, cmdline, creationTime };
}

const SHELLPER = 'C:\\nvm4w\\nodejs\\node.exe C:\\codev\\dist\\terminal\\shellper-main.js "{\\"sessionId\\":\\"s\\"}"';
const TOWER = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\dist\\agent-farm\\servers\\tower-server.js" 4100 --log-file C:\\x.log';

describe('isCodevInfrastructure', () => {
  it('recognizes a shellper and a Tower, built or under tsx', () => {
    expect(isCodevInfrastructure(SHELLPER)).toBe(true);
    expect(isCodevInfrastructure(TOWER)).toBe(true);
    expect(isCodevInfrastructure('node C:/repo/packages/codev/src/agent-farm/servers/tower-server.ts 4100')).toBe(true);
    expect(isCodevInfrastructure('node.exe --max-old-space-size=4096 C:/x/shellper-main.js {}')).toBe(true);
  });

  it('uses the same marker as the shellper sweeps', () => {
    expect(SHELLPER_MARKER).toBe('shellper-main.js');
  });

  it('does not count a mere mention of the scripts', () => {
    expect(isCodevInfrastructure('C:\\Program Files\\Git\\usr\\bin\\grep.exe -r tower-server.js src')).toBe(false);
    expect(isCodevInfrastructure('"C:\\Program Files\\Microsoft VS Code\\Code.exe" C:/x/tower-server.ts')).toBe(false);
    expect(isCodevInfrastructure('node C:/x/not-tower-server.js')).toBe(false);
    expect(isCodevInfrastructure('node C:/x/tower-server.json')).toBe(false);
    expect(isCodevInfrastructure('')).toBe(false);
  });
});

describe('protectedInfrastructure', () => {
  const census = [
    entry(1, 0, 'System'),
    entry(80, 1, SHELLPER), // the session root
    entry(81, 80, 'bash.exe'),
    entry(90, 999, TOWER), // a Tower started inside the session, launcher gone
    entry(91, 90, SHELLPER), // a session that Tower created
    entry(92, 91, 'claude.exe'),
    entry(93, 90, 'powershell.exe -EncodedCommand x'), // Tower's job helper
    entry(95, 999, 'find.exe / -name x'), // an orphan of the session
  ];

  it('protects every Tower and foreign shellper among the candidates, with their descendants', () => {
    const result = protectedInfrastructure(census, 80, [80, 81, 90, 91, 92, 93, 95]);
    expect([...result].sort((a, b) => a - b)).toEqual([90, 91, 92, 93]);
  });

  it('never protects the root, and protects nothing when no candidate is infrastructure', () => {
    expect(protectedInfrastructure(census, 80, [80, 81, 95]).size).toBe(0);
  });

  it('ignores candidates the census does not list', () => {
    expect(protectedInfrastructure(census, 80, [12345]).size).toBe(0);
  });
});
