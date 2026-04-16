import { resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_TOWER_PORT = 4100;
export const AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');
