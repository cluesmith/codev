import { resolve } from 'node:path';
import { homedir } from 'node:os';

export const AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');
