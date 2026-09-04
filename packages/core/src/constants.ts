import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Root of the user-global Agent Farm state directory: cloud credentials, the
 * shared local key, `global.db`, `tower.log`, session logs.
 *
 * `CODEV_AGENT_FARM_DIR` overrides the default (#1515). Nothing in production
 * sets it — its two users are test infrastructure: spawned *test* Towers are
 * pointed at throwaway directories, and the codev vitest harness pins the
 * whole test process into its per-run sandbox (#1597, vitest-setup.ts).
 * Without an override there was no way to isolate either: every test Tower
 * read the developer's real cloud credentials and real local key, wrote its
 * test DB into `~/.agent-farm`, and watched the real config file. A test that
 * then exercised tunnel disconnect acted as the user's registered Tower —
 * deregistering it server-side and deleting the real credentials.
 */
export const AGENT_FARM_DIR = process.env.CODEV_AGENT_FARM_DIR
  ? resolve(process.env.CODEV_AGENT_FARM_DIR)
  : resolve(homedir(), '.agent-farm');
