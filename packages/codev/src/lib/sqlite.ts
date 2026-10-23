/**
 * The one way runtime code opens a better-sqlite3 database (Spec 1658): a binding
 * that cannot load on Windows (scripts disabled at install, or Node switched after
 * it) surfaces with the supported-versions message instead of the raw loader error.
 */

import Database from 'better-sqlite3';
import { withNativeLoadExplanation } from './native-deps.js';

export function openDatabase(filename: string, options?: Database.Options): Database.Database {
  return withNativeLoadExplanation(() => new Database(filename, options));
}
