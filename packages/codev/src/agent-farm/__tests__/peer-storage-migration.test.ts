/**
 * Spec 1967, phase 3: peer storage and the mailbox migration (v21).
 *
 * Three things are proven here, all against temporary SQLite files and an injected clock:
 *
 * 1. **The migration.** A database at today's schema (v20, kept as SQL text in
 *    `fixtures/global-db/v20-upgraded-schema.sql`, never a binary) with held rows of every
 *    reason is migrated by the real runner. Every row is unchanged and still drainable, the
 *    result matches a fresh install after normalisation, `mailbox`'s CHECKs are untouched, a
 *    second run changes nothing, and a failure inside v21 leaves nothing behind.
 * 2. **The mailbox rules for remote mail.** A row held for release is invisible to every
 *    automatic path but `afx inbox`; every writer that changes what a duplicate would be told
 *    mirrors it into `peer_accepted` in the same transaction, and only when it really
 *    changed something; the release flag never outlives `held`; remote rows are never
 *    superseded. Two structural tests keep these claims checked as the code grows.
 * 3. **The peer store**: typed access to the new tables, off by default, and its prune.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { GLOBAL_CURRENT_VERSION, runGlobalMigrations } from '../db/migrations.js';
import * as mailbox from '../db/mailbox.js';
import * as store from '../peer/store.js';
import type { DbMailbox, MailboxGateDetail, MailboxReason } from '../db/types.js';
import { formatVerdict } from '@cluesmith/codev-sdk/hold-verdict';

const DAY = 24 * 60 * 60 * 1000;
/** The injected clock: every time in this file is relative to it. */
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const WS = '/work/codev';
const PEER = '01JMBP000000000000000000AA';
const OTHER_PEER = '01JDEVVM0000000000000000AA';
const FETCHED_FOR = 'https://cloud.codevos.ai 01JSELF0000000000000000AAA';

const FIXTURE_V20 = readFileSync(
  fileURLToPath(new URL('./fixtures/global-db/v20-upgraded-schema.sql', import.meta.url)),
  'utf8',
);
const THIS_FILE = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

// ===========================================================================
// Harness
// ===========================================================================

const opened: Array<{ db: Database.Database; dir: string }> = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A new database file in its own temporary directory, with production's pragmas. */
function openDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'peer-storage-'));
  const db = new Database(join(dir, 'global.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  opened.push({ db, dir });
  return { db, dir };
}

function stamp(db: Database.Database, through: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (let v = 1; v <= through; v++) db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(v);
}

/** Drive the real production runner; returns the lines it logged. */
function migrate(db: Database.Database, dir: string): string[] {
  const logs: string[] = [];
  runGlobalMigrations(db, { log: (m) => logs.push(m), runDir: join(dir, 'run') });
  return logs;
}

/** Today's database: the v20 fixture with markers 1 to 20, as an upgrading install has it. */
function atV20(): { db: Database.Database; dir: string } {
  const h = openDb();
  h.db.exec(FIXTURE_V20);
  stamp(h.db, 20);
  return h;
}

/** A fresh install, exactly as ensureGlobalDatabase builds one. */
function freshDb(): Database.Database {
  const { db } = openDb();
  db.exec(GLOBAL_SCHEMA);
  stamp(db, GLOBAL_CURRENT_VERSION);
  return db;
}

/** A database migrated from today's schema. */
function upgradedDb(): Database.Database {
  const h = atV20();
  migrate(h.db, h.dir);
  return h.db;
}

const markers = (db: Database.Database) =>
  (db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);

const columnNames = (db: Database.Database, table: string) =>
  (db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table) as Array<{ name: string }>).map((c) => c.name);

const tableNames = (db: Database.Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);

// ===========================================================================
// Normalised schema: what "the same schema" means for a fresh and an upgraded install
// ===========================================================================

function normaliseSql(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

/** Every `CHECK(...)` clause in a CREATE statement, its parentheses balanced, quotes respected. */
function checkClauses(sql: string): string[] {
  const clauses: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    let depth = 0;
    let inQuote = false;
    let end = -1;
    for (let i = match.index + match[0].length - 1; i < sql.length; i++) {
      const ch = sql[i];
      if (inQuote) {
        if (ch === "'") inQuote = false;
      } else if (ch === "'") {
        inQuote = true;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unbalanced CHECK in: ${sql}`);
    clauses.push(normaliseSql(`CHECK${sql.slice(match.index + match[0].length - 1, end + 1)}`));
  }
  return clauses.sort();
}

interface NormalisedTable {
  columns: Record<string, { type: string; notnull: number; dflt: string | null; pk: number; hidden: number }>;
  foreignKeys: string[];
  uniques: string[];
  checks: string[];
}

interface NormalisedSchema {
  tables: Record<string, NormalisedTable>;
  indexes: Record<string, { table: string; unique: number; columns: string[]; where: string | null }>;
  triggers: Record<string, string>;
}

function normalisedSchema(db: Database.Database): NormalisedSchema {
  const tables: Record<string, NormalisedTable> = {};
  const indexes: NormalisedSchema['indexes'] = {};
  const sqlOf = (type: string, name: string) =>
    (db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) as { sql: string | null } | undefined)?.sql ?? null;
  const indexColumns = (index: string) =>
    (db.prepare('SELECT name, seqno FROM pragma_index_info(?) ORDER BY seqno').all(index) as Array<{ name: string | null }>).map(
      (c) => c.name ?? '<expr>',
    );

  for (const table of tableNames(db)) {
    const columns: NormalisedTable['columns'] = {};
    for (const c of db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table) as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>) {
      columns[c.name] = { type: c.type.toUpperCase(), notnull: c.notnull, dflt: c.dflt_value, pk: c.pk, hidden: c.hidden };
    }
    const foreignKeys = (db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table) as Array<Record<string, unknown>>)
      .map(({ id: _id, ...fk }) => JSON.stringify(fk))
      .sort();
    const uniques: string[] = [];
    for (const idx of db.prepare('SELECT * FROM pragma_index_list(?)').all(table) as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>) {
      if (idx.origin === 'c') {
        const sql = sqlOf('index', idx.name);
        const where = sql && /\bWHERE\b/i.test(sql) ? normaliseSql(sql.slice(sql.search(/\bWHERE\b/i) + 5)) : null;
        indexes[idx.name] = { table, unique: idx.unique, columns: indexColumns(idx.name), where };
      } else {
        uniques.push(JSON.stringify({ origin: idx.origin, columns: indexColumns(idx.name) }));
      }
    }
    tables[table] = { columns, foreignKeys, uniques: uniques.sort(), checks: checkClauses(sqlOf('table', table) ?? '') };
  }

  const triggers: Record<string, string> = {};
  for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; sql: string }>) {
    triggers[t.name] = normaliseSql(t.sql.replace(/^CREATE TRIGGER (IF NOT EXISTS )?/i, ''));
  }
  return { tables, indexes, triggers };
}

/** Everything a second migration run could change: the schema text and every row of every table. */
function fullDump(db: Database.Database): unknown {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const data: Record<string, unknown[]> = {};
  for (const table of tableNames(db)) data[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return { schema, data };
}

// ===========================================================================
// Held rows at today's schema
// ===========================================================================

/** The v20 mailbox columns, so a fixture row is written exactly as today's code writes one. */
const V20_MAILBOX_INSERT = `
  INSERT INTO mailbox (id, workspace_path, to_agent, terminal_id, from_agent, from_workspace, body, formatted_message,
                       no_enter, status, reason, supersede_key, escalated, created_at, updated_at, resolved_at, not_before, detail)
  VALUES (@id, @workspace_path, @to_agent, @terminal_id, @from_agent, @from_workspace, @body, @formatted_message,
          @no_enter, @status, @reason, @supersede_key, @escalated, @created_at, @updated_at, @resolved_at, @not_before, @detail)`;

const REASONS: Array<MailboxReason | null> = ['busy', 'no-profile', 'no-live-pty', null];
const DETAILS: MailboxGateDetail[] = ['user-text', 'no-region-end', 'no-composer-marker', 'recent-input', 'composer-redraw'];

/** Held rows of every reason, with and without a detail and a (past) `not_before`, plus two terminal rows. */
function seedV20Rows(db: Database.Database): string[] {
  const held: string[] = [];
  let n = 0;
  const insert = (fields: Partial<Record<string, unknown>>) => {
    n++;
    const row = {
      id: `row-${String(n).padStart(3, '0')}`,
      workspace_path: WS,
      to_agent: 'main',
      terminal_id: `term-${n}`,
      from_agent: 'builder-spir-1',
      from_workspace: WS,
      body: `body ${n}`,
      formatted_message: `[from builder-spir-1] body ${n}`,
      no_enter: n % 2,
      status: 'held',
      reason: null,
      supersede_key: null,
      escalated: n % 3 === 0 ? 1 : 0,
      created_at: T0 - DAY + n * 1000,
      updated_at: T0 - DAY + n * 1000 + 1,
      resolved_at: null,
      not_before: null,
      detail: null,
      ...fields,
    };
    db.prepare(V20_MAILBOX_INSERT).run(row);
    if (row.status === 'held') held.push(row.id);
  };
  for (const reason of REASONS) {
    for (const detail of [null, 'user-text'] as const) {
      for (const notBefore of [null, T0 - 60_000]) insert({ reason, detail, not_before: notBefore });
    }
  }
  for (const detail of DETAILS) insert({ reason: 'busy', detail, not_before: T0 - 5_000 });
  insert({ status: 'delivered', resolved_at: T0 - 1000 });
  insert({ status: 'dismissed', reason: 'busy', resolved_at: T0 - 2000 });
  return held;
}

const V20_COLUMNS = [
  'id', 'workspace_path', 'to_agent', 'terminal_id', 'from_agent', 'from_workspace', 'body', 'formatted_message', 'no_enter',
  'status', 'reason', 'supersede_key', 'escalated', 'created_at', 'updated_at', 'resolved_at', 'not_before', 'detail',
];

function v20Projection(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(V20_COLUMNS.map((c) => [c, r[c]])));
}

// ===========================================================================
// 1. The migration
// ===========================================================================

describe('migration v21 on a database at today\'s schema', () => {
  it('the fixture is today\'s schema: v20 markers and no v21 column or table', () => {
    const { db } = atV20();
    expect(markers(db)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(columnNames(db, 'mailbox')).not.toContain('release_hold');
    expect(tableNames(db).filter((t) => t.startsWith('peer_'))).toEqual([]);
  });

  it('keeps every held row unchanged and still drainable, of every reason, detail and not_before', () => {
    const { db, dir } = atV20();
    const held = seedV20Rows(db);
    expect(held.length).toBe(21);
    const before = db.prepare('SELECT * FROM mailbox ORDER BY id').all() as Array<Record<string, unknown>>;

    const logs = migrate(db, dir);

    expect(logs).toEqual(['[info] Added Tower-to-Tower messaging storage (Spec 1967)']);
    expect(markers(db)).toContain(21);
    const after = db.prepare('SELECT * FROM mailbox ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(v20Projection(after)).toEqual(v20Projection(before));
    for (const row of after) {
      expect(row).toMatchObject({
        remote_tower_id: null,
        remote_message_id: null,
        remote_sender: null,
        remote_owner_email: null,
        release_hold: 0,
        released_at: null,
      });
    }

    // Still drainable: the drainer's query returns every held row, in enqueue order, and so do
    // the inbox listing and the held count.
    expect(mailbox.findHeldForAgent(db, WS, 'main', T0).map((r) => r.id)).toEqual(held);
    expect(mailbox.listHeld(db, WS).map((r) => r.id)).toEqual(held);
    expect(mailbox.heldSummaryForWorkspace(db, WS, T0).total).toBe(held.length);
    expect(mailbox.findStarvingAgents(db, T0)).toEqual([
      expect.objectContaining({ workspacePath: WS, toAgent: 'main', count: held.length }),
    ]);
    // And the writers work on the migrated table.
    expect(mailbox.setHeldVerdict(db, held[0], 'no-live-pty', null, T0)).toBe(true);
    expect(mailbox.markDelivered(db, held[1], T0)).toBe(true);
    expect(mailbox.dismiss(db, held[2], T0)).toBe(true);
    expect(mailbox.findHeldForAgent(db, WS, 'main', T0).map((r) => r.id)).toEqual([held[0], ...held.slice(3)]);
  });

  it('leaves the switch off and no grant on an upgraded database, as on a fresh one', () => {
    for (const db of [upgradedDb(), freshDb()]) {
      expect(store.readRemoteMessaging(db)).toEqual({ state: 'off', changedAt: null });
      expect(store.listGrants(db)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM peer_settings').get()).toEqual({ n: 0 });
    }
  });

  it('a fresh install and an upgraded one have the same schema after normalisation', () => {
    const fresh = normalisedSchema(freshDb());
    expect(Object.keys(fresh.tables)).toEqual(
      expect.arrayContaining(['peer_settings', 'peer_grants', 'peer_towers', 'peer_tower_names', 'peer_outbox', 'peer_accepted', 'peer_records']),
    );
    expect(normalisedSchema(upgradedDb())).toEqual(fresh);

    // And from the start of the chain, as the oldest installs walk it.
    const chain = openDb();
    stamp(chain.db, 1);
    migrate(chain.db, chain.dir);
    expect(markers(chain.db)).toEqual(Array.from({ length: GLOBAL_CURRENT_VERSION }, (_, i) => i + 1));
    expect(normalisedSchema(chain.db)).toEqual(fresh);
  });

  it('the comparison sees a difference when there is one', () => {
    const fresh = freshDb();
    const other = freshDb();
    other.exec('CREATE INDEX idx_extra ON peer_outbox(sent_at) WHERE state = \'held\'');
    expect(normalisedSchema(other)).not.toEqual(normalisedSchema(fresh));
    const checks = checkClauses("CREATE TABLE t (a TEXT CHECK(a IN ('x', 'y)')),  b INTEGER CHECK (b > 0))");
    expect(checks).toEqual(["CHECK(a IN('x','y)'))", 'CHECK(b > 0)']);
  });

  it("leaves mailbox's CHECK clauses exactly as they were", () => {
    const { db, dir } = atV20();
    const sql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mailbox'").get() as { sql: string }).sql;
    const before = checkClauses(sql());
    expect(before).toEqual([
      "CHECK(reason IN('busy','no-profile','no-live-pty'))",
      "CHECK(status IN('held','delivered','superseded','dismissed'))",
    ]);
    migrate(db, dir);
    expect(checkClauses(sql())).toEqual(before);
  });

  it('running the migration twice changes nothing', () => {
    const { db, dir } = atV20();
    seedV20Rows(db);
    migrate(db, dir);
    const once = fullDump(db);
    expect(migrate(db, dir)).toEqual([]);
    expect(fullDump(db)).toEqual(once);
  });

  it('skips a column that already exists (the PRAGMA gate) and still records the marker', () => {
    const { db, dir } = atV20();
    db.exec('ALTER TABLE mailbox ADD COLUMN release_hold INTEGER NOT NULL DEFAULT 0');
    migrate(db, dir);
    expect(columnNames(db, 'mailbox').filter((c) => c === 'release_hold')).toHaveLength(1);
    expect(markers(db)).toContain(21);
  });

  it('is one transaction: a failure inside it leaves no column, no table and no marker', () => {
    const { db, dir } = atV20();
    // A view where a v21 table belongs: CREATE TABLE IF NOT EXISTS skips it, and indexing it
    // then fails, after the ALTERs and the first tables have run.
    db.exec('CREATE VIEW peer_tower_names AS SELECT 1 AS tower_id');
    expect(() => migrate(db, dir)).toThrow(/views may not be indexed/);
    expect(columnNames(db, 'mailbox')).not.toContain('remote_tower_id');
    expect(tableNames(db).filter((t) => t.startsWith('peer_'))).toEqual([]);
    expect(markers(db)).not.toContain(21);
  });
});

// ===========================================================================
// 2. Remote mail in the mailbox
// ===========================================================================

function remoteInput(overrides: Partial<mailbox.RemoteEnqueueInput> & { messageId?: string; toAgent?: string } = {}): mailbox.RemoteEnqueueInput {
  const messageId = overrides.messageId ?? randomUUID();
  const body = overrides.body ?? `remote body ${messageId}`;
  return {
    workspacePath: WS,
    toAgent: overrides.toAgent ?? 'main',
    body,
    formattedMessage: `[remote, from ana-s-mbp] ${body}`,
    // Mail held for release has had no gate attempt, so it has no reason (the plan's
    // representation); other rows here start as if their first attempt had held them busy.
    reason: overrides.releaseHold ? null : 'busy',
    releaseHold: false,
    remote: {
      sender: { towerId: PEER, towerSlug: 'ana-s-mbp', address: { workspace: 'codev', kind: 'architect', name: 'local' } },
      messageId,
      ownerEmail: 'ana@example.com',
      payloadSha256: createHash('sha256').update(body).digest('hex'),
      sentAt: T0,
    },
    ...overrides,
  };
}

/** Enqueue a remote row and return it; fails the test if it was not accepted. */
function addRemote(db: Database.Database, overrides: Parameters<typeof remoteInput>[0] = {}, now = T0): DbMailbox {
  const result = mailbox.enqueueRemote(db, remoteInput(overrides), now);
  if (!result.accepted) throw new Error('expected a new remote row');
  return result.row;
}

function acceptedOf(db: Database.Database, row: Pick<DbMailbox, 'remote_tower_id' | 'remote_message_id'>): store.PeerAcceptedRow {
  const accepted = store.getAccepted(db, row.remote_tower_id!, row.remote_message_id!);
  if (!accepted) throw new Error('expected an accepted-once row');
  return accepted;
}

const addLocal = (db: Database.Database, toAgent = 'main', now = T0) =>
  mailbox.enqueue(db, { workspacePath: WS, toAgent, body: 'local body', formattedMessage: '[from x] local body' }, now);

const acceptedTable = (db: Database.Database) => db.prepare('SELECT * FROM peer_accepted ORDER BY peer_tower_id, message_id').all();
const mailboxRow = (db: Database.Database, id: string) => db.prepare('SELECT * FROM mailbox WHERE id = ?').get(id);

describe('a row held for release', () => {
  it('is never drained, escalated, starving or counted, but listHeld and getById still return it', () => {
    const db = freshDb();
    const old = T0 - 10 * DAY;
    const local = addLocal(db, 'main', old);
    const remote = addRemote(db, {}, old);
    const forRelease = addRemote(db, { releaseHold: true }, old);
    expect(forRelease.release_hold).toBe(1);
    expect(mailbox.reportedReason(forRelease)).toBe('held-for-release');

    const ids = (rows: DbMailbox[]) => rows.map((r) => r.id).sort();
    expect(ids(mailbox.findHeldForAgent(db, WS, 'main', T0))).toEqual([local.id, remote.id].sort());
    expect(ids(mailbox.findEscalatable(db, 60_000, T0))).toEqual([local.id, remote.id].sort());
    expect(mailbox.findStarvingAgents(db, T0)).toEqual([expect.objectContaining({ toAgent: 'main', count: 2 })]);
    expect(mailbox.heldSummaryForWorkspace(db, WS, T0)).toMatchObject({ total: 2 });
    expect(ids(mailbox.listHeld(db, WS))).toEqual([local.id, remote.id, forRelease.id].sort());
    expect(ids(mailbox.listHeld(db))).toEqual([local.id, remote.id, forRelease.id].sort());
    expect(mailbox.getById(db, forRelease.id)).toMatchObject({ id: forRelease.id, release_hold: 1, status: 'held' });

    // Released, it is ordinary held mail again on every one of those paths.
    expect(mailbox.release(db, forRelease.id, T0)).toBe(true);
    expect(mailbox.findHeldForAgent(db, WS, 'main', T0)).toHaveLength(3);
    expect(mailbox.heldSummaryForWorkspace(db, WS, T0)).toMatchObject({ total: 3 });
    expect(mailbox.reportedReason(mailbox.getById(db, forRelease.id)!)).toBeNull();
  });

  it('reports no gate detail while held for release, and its own again once released', () => {
    const db = freshDb();
    const row = addRemote(db);
    mailbox.setHeldVerdict(db, row.id, 'busy', 'user-text', T0 + 1);
    mailbox.holdForRelease(db, row.id, T0 + 2);
    const held = mailbox.getById(db, row.id)!;
    expect(held).toMatchObject({ reason: 'busy', detail: 'user-text', release_hold: 1 });
    expect([mailbox.reportedReason(held), mailbox.reportedDetail(held)]).toEqual(['held-for-release', null]);
    expect(formatVerdict(mailbox.reportedReason(held), mailbox.reportedDetail(held))).toBe('held-for-release');

    mailbox.release(db, row.id, T0 + 3);
    const released = mailbox.getById(db, row.id)!;
    expect([mailbox.reportedReason(released), mailbox.reportedDetail(released)]).toEqual(['busy', 'user-text']);
    expect(formatVerdict(mailbox.reportedReason(released), mailbox.reportedDetail(released))).toBe('busy:user-text');
  });
});

describe('mirror: enqueueRemote', () => {
  it('inserts the accepted-once row with the mailbox row, carrying its state and expiry', () => {
    const db = freshDb();
    const row = addRemote(db);
    expect(row).toMatchObject({
      status: 'held',
      reason: 'busy',
      remote_tower_id: PEER,
      supersede_key: null,
      not_before: null,
      no_enter: 0,
      release_hold: 0,
      remote_owner_email: 'ana@example.com',
    });
    expect(mailbox.readRemoteSender(row)).toEqual({
      towerId: PEER,
      towerSlug: 'ana-s-mbp',
      address: { workspace: 'codev', kind: 'architect', name: 'local' },
    });
    expect(acceptedOf(db, row)).toEqual({
      peerTowerId: PEER,
      messageId: row.remote_message_id,
      payloadSha256: createHash('sha256').update(row.body).digest('hex'),
      mailboxId: row.id,
      state: 'held',
      reason: 'busy',
      expiresAt: T0 + 30 * DAY,
      acceptedAt: T0,
      updatedAt: T0,
    });
    const forRelease = addRemote(db, { releaseHold: true });
    expect(forRelease).toMatchObject({ status: 'held', reason: null, release_hold: 1 });
    expect(acceptedOf(db, forRelease)).toMatchObject({ state: 'held', reason: 'held-for-release' });
  });

  it('a row with no gate verdict yet is NULL in the mailbox and busy to a duplicate', () => {
    const db = freshDb();
    const row = addRemote(db, { reason: null });
    expect(row.reason).toBeNull();
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'busy' });
    expect(store.duplicateAnswer(acceptedOf(db, row))).toEqual({ outcome: 'held', reason: 'busy', duplicate: true });
  });

  it('refuses mail held for release that claims a gate reason', () => {
    const db = freshDb();
    expect(() => mailbox.enqueueRemote(db, { ...remoteInput({ releaseHold: true }), reason: 'busy' }, T0)).toThrow(/no gate attempt/);
    expect(acceptedTable(db)).toEqual([]);
  });

  it('writes nothing for a second arrival of the same message, and returns the first one\'s row', () => {
    const db = freshDb();
    const first = addRemote(db);
    const again = mailbox.enqueueRemote(db, remoteInput({ messageId: first.remote_message_id! }), T0 + 1000);
    expect(again).toEqual({ accepted: false, existing: acceptedOf(db, first) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox').get()).toEqual({ n: 1 });
    // The same message id from a different peer is a different message.
    const otherPeer = remoteInput({ messageId: first.remote_message_id! });
    otherPeer.remote.sender = { ...otherPeer.remote.sender, towerId: OTHER_PEER };
    expect(mailbox.enqueueRemote(db, otherPeer, T0).accepted).toBe(true);
  });

  it('a local row has no accepted-once row and no remote provenance', () => {
    const db = freshDb();
    const local = addLocal(db);
    expect(local).toMatchObject({ remote_tower_id: null, remote_sender: null, release_hold: 0 });
    expect(mailbox.readRemoteSender(local)).toBeNull();
    expect(acceptedTable(db)).toEqual([]);
  });

  it('refuses a sender whose address does not fit the payload rules', () => {
    const db = freshDb();
    const bad = remoteInput();
    bad.remote.sender = { ...bad.remote.sender, address: { workspace: 'codev', kind: 'id', name: 'has space' } };
    expect(() => mailbox.enqueueRemote(db, bad, T0)).toThrow(/does not fit/);
    expect(acceptedTable(db)).toEqual([]);
  });
});

describe('mirror: setHeldVerdict', () => {
  it('a move of the reason (busy to no-live-pty) is mirrored; a move of the detail alone is not', () => {
    const db = freshDb();
    const row = addRemote(db);
    expect(mailbox.setHeldVerdict(db, row.id, 'busy', 'user-text', T0 + 1)).toBe(true);
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'busy', updatedAt: T0 });
    expect(mailbox.setHeldVerdict(db, row.id, 'no-live-pty', null, T0 + 2)).toBe(true);
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'no-live-pty', updatedAt: T0 + 2 });
  });

  it('under a row held for release, a move of its own reason changes nothing a duplicate is told', () => {
    const db = freshDb();
    const row = addRemote(db, { releaseHold: true });
    expect(mailbox.setHeldVerdict(db, row.id, 'no-live-pty', null, T0 + 1)).toBe(true);
    expect(acceptedOf(db, row)).toMatchObject({ reason: 'held-for-release', updatedAt: T0 });
  });
});

describe('mirror: markDelivered', () => {
  it('tells the accepted-once row delivered', () => {
    const db = freshDb();
    const row = addRemote(db);
    expect(mailbox.markDelivered(db, row.id, T0 + 5)).toBe(true);
    expect(acceptedOf(db, row)).toMatchObject({ state: 'delivered', reason: null, updatedAt: T0 + 5 });
    expect(store.duplicateAnswer(acceptedOf(db, row))).toEqual({ outcome: 'delivered', duplicate: true });
  });

  it('clears release_hold on a row moved to held for release while its write was under way', () => {
    const db = freshDb();
    const row = addRemote(db);
    expect(mailbox.holdForRelease(db, row.id, T0 + 1)).toBe(true);
    expect(mailbox.markDelivered(db, row.id, T0 + 2)).toBe(true);
    expect(mailboxRow(db, row.id)).toMatchObject({ status: 'delivered', release_hold: 0 });
    expect(acceptedOf(db, row)).toMatchObject({ state: 'delivered', reason: null });
  });
});

describe('mirror: dismiss', () => {
  it('tells the accepted-once row dismissed, and clears release_hold in the same statement', () => {
    const db = freshDb();
    const row = addRemote(db, { releaseHold: true });
    expect(mailbox.dismiss(db, row.id, T0 + 3)).toBe(true);
    expect(mailboxRow(db, row.id)).toMatchObject({ status: 'dismissed', release_hold: 0 });
    expect(acceptedOf(db, row)).toMatchObject({ state: 'dismissed', reason: null, updatedAt: T0 + 3 });
    expect(store.duplicateAnswer(acceptedOf(db, row))).toEqual({ outcome: 'refused', reason: 'dismissed', duplicate: true });
  });
});

describe('mirror: dismissHeldForAgent', () => {
  it('afx cleanup of a builder leaves every one of its remote rows dismissed, and a duplicate is refused, dismissed', () => {
    const db = freshDb();
    const builder = 'builder-spir-7';
    const plain = addRemote(db, { toAgent: builder });
    const forRelease = addRemote(db, { toAgent: builder, releaseHold: true });
    const local = addLocal(db, builder);
    const delivered = addRemote(db, { toAgent: builder });
    mailbox.markDelivered(db, delivered.id, T0 + 1);
    const elsewhere = addRemote(db, { toAgent: 'main' });

    expect(mailbox.dismissHeldForAgent(db, WS, builder, T0 + 10)).toBe(3);

    for (const row of [plain, forRelease]) {
      expect(mailboxRow(db, row.id)).toMatchObject({ status: 'dismissed', release_hold: 0 });
      expect(acceptedOf(db, row)).toMatchObject({ state: 'dismissed', reason: null, updatedAt: T0 + 10 });
      const again = mailbox.enqueueRemote(db, remoteInput({ toAgent: builder, messageId: row.remote_message_id! }), T0 + 20);
      expect(again.accepted).toBe(false);
      if (!again.accepted) {
        expect(store.duplicateAnswer(again.existing)).toEqual({ outcome: 'refused', reason: 'dismissed', duplicate: true });
      }
    }
    expect(mailboxRow(db, local.id)).toMatchObject({ status: 'dismissed' });
    // Only the rows the statement changed are mirrored.
    expect(acceptedOf(db, delivered)).toMatchObject({ state: 'delivered', updatedAt: T0 + 1 });
    expect(acceptedOf(db, elsewhere)).toMatchObject({ state: 'held', reason: 'busy', updatedAt: T0 });
  });
});

describe('mirror: holdForRelease', () => {
  it('moves a held remote row to held for release, and only a held remote row', () => {
    const db = freshDb();
    const row = addRemote(db);
    expect(mailbox.holdForRelease(db, row.id, T0 + 4)).toBe(true);
    expect(mailboxRow(db, row.id)).toMatchObject({ status: 'held', release_hold: 1, reason: 'busy' });
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'held-for-release', updatedAt: T0 + 4 });
    expect(store.duplicateAnswer(acceptedOf(db, row))).toEqual({ outcome: 'held', reason: 'held-for-release', duplicate: true });

    const local = addLocal(db);
    expect(mailbox.holdForRelease(db, local.id, T0 + 5)).toBe(false);
    expect(mailboxRow(db, local.id)).toMatchObject({ release_hold: 0 });
  });
});

describe('mirror: release', () => {
  it('reports the row\'s own reason again, as it is now', () => {
    const db = freshDb();
    const row = addRemote(db, { releaseHold: true });
    mailbox.setHeldVerdict(db, row.id, 'no-live-pty', null, T0 + 1);
    expect(mailbox.release(db, row.id, T0 + 6)).toBe(true);
    expect(mailboxRow(db, row.id)).toMatchObject({ status: 'held', release_hold: 0, released_at: T0 + 6, reason: 'no-live-pty' });
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'no-live-pty', updatedAt: T0 + 6 });
    expect(mailbox.findHeldForAgent(db, WS, 'main', T0 + 6).map((r) => r.id)).toEqual([row.id]);
  });

  it('a row released before any gate attempt keeps no reason, and a duplicate is told busy', () => {
    const db = freshDb();
    const row = addRemote(db, { releaseHold: true });
    expect(mailbox.release(db, row.id, T0 + 7)).toBe(true);
    expect(mailboxRow(db, row.id)).toMatchObject({ status: 'held', release_hold: 0, reason: null });
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'busy', updatedAt: T0 + 7 });
  });
});

describe('the mirror is atomic with the mailbox write', () => {
  /** Make the next write to peer_accepted fail, after the mailbox statement has run. */
  const breakMirror = (db: Database.Database) =>
    db.exec(`CREATE TRIGGER inject_mirror_failure BEFORE UPDATE ON peer_accepted BEGIN SELECT RAISE(ABORT, 'injected mirror failure'); END`);

  const writers: Array<[string, (db: Database.Database, row: DbMailbox) => unknown, boolean]> = [
    ['setHeldVerdict', (db, row) => mailbox.setHeldVerdict(db, row.id, 'no-live-pty', null, T0 + 1), false],
    ['markDelivered', (db, row) => mailbox.markDelivered(db, row.id, T0 + 1), false],
    ['dismiss', (db, row) => mailbox.dismiss(db, row.id, T0 + 1), false],
    ['dismissHeldForAgent', (db) => mailbox.dismissHeldForAgent(db, WS, 'main', T0 + 1), false],
    ['holdForRelease', (db, row) => mailbox.holdForRelease(db, row.id, T0 + 1), false],
    ['release', (db, row) => mailbox.release(db, row.id, T0 + 1), true],
  ];

  it.each(writers)('%s: a failure after the mailbox write rolls both back', (_name, write, heldForRelease) => {
    const db = freshDb();
    const row = addRemote(db, { releaseHold: heldForRelease });
    const before = { mailbox: mailboxRow(db, row.id), accepted: acceptedTable(db) };
    breakMirror(db);
    expect(() => write(db, row)).toThrow(/injected mirror failure/);
    expect({ mailbox: mailboxRow(db, row.id), accepted: acceptedTable(db) }).toEqual(before);
  });

  it('enqueueRemote: a failure on the mailbox insert leaves no accepted-once row either', () => {
    const db = freshDb();
    db.exec(`CREATE TRIGGER inject_insert_failure BEFORE INSERT ON mailbox BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
    expect(() => mailbox.enqueueRemote(db, remoteInput(), T0)).toThrow(/injected insert failure/);
    expect(acceptedTable(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox').get()).toEqual({ n: 0 });
  });
});

describe('a guarded update that changes no row', () => {
  it('leaves peer_accepted exactly as it was', () => {
    const db = freshDb();
    const delivered = addRemote(db);
    mailbox.markDelivered(db, delivered.id, T0 + 1);
    const dismissed = addRemote(db);
    mailbox.dismiss(db, dismissed.id, T0 + 1);
    const held = addRemote(db);
    const forRelease = addRemote(db, { releaseHold: true });
    const before = acceptedTable(db);

    expect(mailbox.markDelivered(db, delivered.id, T0 + 9)).toBe(false);
    expect(mailbox.dismiss(db, dismissed.id, T0 + 9)).toBe(false);
    expect(mailbox.setHeldVerdict(db, held.id, 'busy', null, T0 + 9)).toBe(false);
    expect(mailbox.setHeldVerdict(db, delivered.id, 'no-live-pty', null, T0 + 9)).toBe(false);
    expect(mailbox.holdForRelease(db, forRelease.id, T0 + 9)).toBe(false);
    expect(mailbox.holdForRelease(db, delivered.id, T0 + 9)).toBe(false);
    expect(mailbox.release(db, held.id, T0 + 9)).toBe(false);
    expect(mailbox.release(db, dismissed.id, T0 + 9)).toBe(false);
    expect(mailbox.dismissHeldForAgent(db, WS, 'nobody', T0 + 9)).toBe(0);

    expect(acceptedTable(db)).toEqual(before);
  });
});

describe('invariants of remote rows', () => {
  it('release_hold = 1 only ever goes with held, after release, delivery and dismissal', () => {
    const db = freshDb();
    const rows = Array.from({ length: 8 }, (_, i) => addRemote(db, { releaseHold: true, toAgent: i < 6 ? 'main' : 'builder-x' }));
    mailbox.markDelivered(db, rows[0].id, T0 + 1);
    mailbox.dismiss(db, rows[1].id, T0 + 1);
    mailbox.release(db, rows[2].id, T0 + 1);
    mailbox.markDelivered(db, rows[2].id, T0 + 2);
    mailbox.release(db, rows[3].id, T0 + 1);
    mailbox.dismissHeldForAgent(db, WS, 'builder-x', T0 + 3);
    const stray = db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE status != 'held' AND release_hold = 1").get();
    expect(stray).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE release_hold = 1').get()).toEqual({ n: 2 });
  });

  it('a remote row never has a supersede_key, so supersede and the notice dismissal never reach it', () => {
    const db = freshDb();
    // An input carrying a key it should not have (by a cast) still stores none.
    const sneaky = { ...remoteInput(), supersedeKey: 'cron-task' } as unknown as mailbox.RemoteEnqueueInput;
    const result = mailbox.enqueueRemote(db, sneaky, T0);
    expect(result.accepted && result.row.supersede_key).toBeNull();
    const remote = addRemote(db);

    mailbox.supersede(db, WS, 'cron-task', { workspacePath: WS, toAgent: 'main', body: 'b', formattedMessage: 'f' }, T0 + 1);
    expect(mailbox.dismissHeldWithKey(db, WS, `${mailbox.NOTICE_SUPERSEDE_PREFIX}main`, T0 + 2)).toBe(0);

    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE remote_tower_id IS NOT NULL AND supersede_key IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE remote_tower_id IS NOT NULL AND status != 'held'").get()).toEqual({ n: 0 });
    expect(acceptedOf(db, remote)).toMatchObject({ state: 'held', updatedAt: T0 });
  });

  it('the key-based writers and release name their side in SQL, so a broken row still is not reached', () => {
    const db = freshDb();
    // Break the invariants by hand: a remote row with a key, a local row held for release.
    const remote = addRemote(db);
    db.prepare('UPDATE mailbox SET supersede_key = ? WHERE id = ?').run('cron-task', remote.id);
    const local = mailbox.enqueue(db, { workspacePath: WS, toAgent: 'main', body: 'b', formattedMessage: 'f', reason: 'busy' }, T0);
    db.prepare('UPDATE mailbox SET release_hold = 1 WHERE id = ?').run(local.id);

    expect(mailbox.dismissHeldWithKey(db, WS, 'cron-task', T0 + 1)).toBe(0);
    mailbox.supersede(db, WS, 'cron-task', { workspacePath: WS, toAgent: 'main', body: 'b2', formattedMessage: 'f2' }, T0 + 2);
    expect(mailboxRow(db, remote.id)).toMatchObject({ status: 'held' });
    expect(acceptedOf(db, remote)).toMatchObject({ state: 'held', updatedAt: T0 });

    expect(mailbox.release(db, local.id, T0 + 3)).toBe(false);
    expect(mailboxRow(db, local.id)).toMatchObject({ status: 'held', release_hold: 1 });
  });
});

describe('retention', () => {
  it('pruneTerminal at 1 day removes a delivered remote row, and its accepted-once row lives to 30 days after sentAt', () => {
    const db = freshDb();
    const row = addRemote(db);
    mailbox.markDelivered(db, row.id, T0);

    expect(mailbox.pruneTerminal(db, 1, T0 + DAY + 1)).toBe(1);
    expect(mailbox.getById(db, row.id)).toBeNull();
    expect(acceptedOf(db, row)).toMatchObject({ state: 'delivered' });

    // A retry on day 5 is answered from the accepted-once row alone, and writes nothing.
    const retry = mailbox.enqueueRemote(db, remoteInput({ messageId: row.remote_message_id! }), T0 + 5 * DAY);
    expect(retry.accepted).toBe(false);
    if (!retry.accepted) expect(store.duplicateAnswer(retry.existing)).toEqual({ outcome: 'delivered', duplicate: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox').get()).toEqual({ n: 0 });

    expect(store.prunePeerStorage(db, 30, T0 + 30 * DAY - 1).accepted).toBe(0);
    expect(acceptedOf(db, row)).toMatchObject({ state: 'delivered' });
    expect(store.prunePeerStorage(db, 30, T0 + 30 * DAY + 1).accepted).toBe(1);
    expect(store.getAccepted(db, PEER, row.remote_message_id!)).toBeNull();
  });

  it('the peer prune asked for 1 day uses 30, and never removes a held outbox row', () => {
    const db = freshDb();
    const now = T0 + 100 * DAY;
    const record = (at: number) =>
      store.insertRecord(db, {
        direction: 'outbound', at, kind: 'message', peerTowerId: PEER, peerSlug: 'devvm', tunnelSession: null,
        messageId: randomUUID(), fromAddress: 'codev:architect', toAddress: 'afx://devvm/codev:architect', payloadSize: 10,
        outcome: 'delivered', reason: null,
      });
    record(now - 31 * DAY);
    record(now - 29 * DAY);
    store.countAggregate(db, { direction: 'inbound', at: now - 40 * DAY, sender: { tunnelSession: 's1' }, outcome: 'not-verified', reason: null });
    store.countAggregate(db, { direction: 'inbound', at: now - 2 * DAY, sender: { tunnelSession: 's1' }, outcome: 'not-verified', reason: null });

    const outbox = (state: 'held' | store.PeerOutboxResolvedState, resolvedAgo: number | null, createdAgo: number) => {
      const row = store.insertOutbox(
        db,
        { messageId: randomUUID(), peerTowerId: PEER, toAddress: 'afx://devvm/codev:architect', payload: Buffer.from('{}'),
          sentAt: now - createdAgo, fromWorkspacePath: WS, fromAgent: 'main' },
        now - createdAgo,
      );
      if (state !== 'held') store.resolveOutbox(db, row.messageId, { state, outcome: null, reason: null, attempted: false }, now - (resolvedAgo ?? 0));
      return row.messageId;
    };
    const heldOld = outbox('held', null, 60 * DAY);
    outbox('accepted', 31 * DAY, 32 * DAY);
    outbox('refused', 40 * DAY, 41 * DAY);
    outbox('dismissed', 35 * DAY, 36 * DAY);
    outbox('expired', 31 * DAY, 61 * DAY);
    const recent = outbox('accepted', 29 * DAY, 29 * DAY);

    expect(store.prunePeerStorage(db, 1, now)).toEqual({ retentionDays: 30, records: 2, outbox: 4, accepted: 0 });
    expect(store.getOutbox(db, heldOld)).toMatchObject({ state: 'held' });
    expect(store.getOutbox(db, recent)).toMatchObject({ state: 'accepted' });
    expect(store.listRecords(db).map((r) => r.lastAt).sort()).toEqual([now - 29 * DAY, now - 2 * DAY].sort());
    expect(store.prunePeerStorage(db, 45, now).retentionDays).toBe(45);
    expect(() => store.prunePeerStorage(db, Number.NaN, now)).toThrow(/retention/);
  });
});

// ===========================================================================
// 3. The peer store
// ===========================================================================

describe('peer store: the switch and the cached listing', () => {
  it('reads off until a human turns it on, and a listing write never touches it', () => {
    const db = freshDb();
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [], fetchedFor: FETCHED_FOR }, T0);
    expect(store.readRemoteMessaging(db)).toEqual({ state: 'off', changedAt: null });
    store.writeRemoteMessaging(db, 'on', T0 + 1);
    store.writeListing(db, { relay: null, limits: limits(), towers: [], fetchedFor: FETCHED_FOR }, T0 + 2);
    expect(store.readRemoteMessaging(db)).toEqual({ state: 'on', changedAt: T0 + 1 });
    store.writeRemoteMessaging(db, 'off', T0 + 3);
    expect(store.readRemoteMessaging(db)).toEqual({ state: 'off', changedAt: T0 + 3 });
  });

  function limits() {
    return { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 };
  }

  it('keeps the listing and every name a Tower has had', () => {
    const db = freshDb();
    expect(store.readListing(db)).toEqual({ refreshedAt: null, relayProtocols: null, limits: null, towers: [] });
    const devvm = { towerId: OTHER_PEER, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' as const };
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [devvm], fetchedFor: FETCHED_FOR }, T0);
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [{ ...devvm, slug: 'build-box', online: false }], fetchedFor: FETCHED_FOR }, T0 + 10);
    expect(store.readListing(db)).toEqual({
      refreshedAt: T0 + 10,
      relayProtocols: [1],
      limits: limits(),
      towers: [{ ...devvm, slug: 'build-box', online: false }],
    });
    expect(store.listTowerNames(db, OTHER_PEER)).toEqual([
      { towerId: OTHER_PEER, slug: 'devvm', firstSeenAt: T0, lastSeenAt: T0 },
      { towerId: OTHER_PEER, slug: 'build-box', firstSeenAt: T0 + 10, lastSeenAt: T0 + 10 },
    ]);
    store.writeListing(db, { relay: null, limits: limits(), towers: [], fetchedFor: FETCHED_FOR }, T0 + 20);
    expect(store.readListing(db)).toMatchObject({ relayProtocols: null, towers: [] });
    expect(store.listTowerNames(db)).toHaveLength(2);
  });

  it("holds the cache to the registration it was fetched under, and leaves a human's grants alone", () => {
    const db = freshDb();
    const devvm = { towerId: OTHER_PEER, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' as const };
    // Nothing cached: nothing to drop, and nothing written.
    expect(store.forgetListingUnlessFor(db, FETCHED_FOR)).toBe(false);
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [devvm], fetchedFor: FETCHED_FOR }, T0);
    store.putGrant(db, { peerTowerId: OTHER_PEER, scope: 'all', workspacePath: null, architect: null, mode: 'deliver' }, T0);
    expect(store.readListingRelay(db)).toEqual({ refreshedAt: T0, relayProtocols: [1] });
    expect(store.forgetListingUnlessFor(db, FETCHED_FOR)).toBe(false);
    expect(store.readListing(db).towers).toEqual([devvm]);

    expect(store.forgetListingUnlessFor(db, 'https://cloud.codevos.ai 01JANOTHERTOWER00000000AA')).toBe(true);
    expect(store.readListing(db)).toEqual({ refreshedAt: null, relayProtocols: null, limits: null, towers: [] });
    expect(store.readListingRelay(db)).toEqual({ refreshedAt: null, relayProtocols: null });
    expect(store.listTowerNames(db)).toEqual([]);
    expect(store.listGrants(db)).toHaveLength(1);
    expect(store.readRemoteMessaging(db).state).toBe('off');
    // Dropped once: the empty cache belongs to no registration, so any other finds nothing to drop.
    expect(store.forgetListingUnlessFor(db, FETCHED_FOR)).toBe(false);
  });

  it("starts the former names afresh when a listing comes for another registration", () => {
    const db = freshDb();
    const devvm = { towerId: OTHER_PEER, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' as const };
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [devvm], fetchedFor: FETCHED_FOR }, T0);
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [{ ...devvm, slug: 'vm2' }], fetchedFor: FETCHED_FOR }, T0 + 1);
    expect(store.listTowerNames(db)).toHaveLength(2);
    store.writeListing(db, { relay: { protocols: [1] }, limits: limits(), towers: [{ ...devvm, slug: 'vm3' }], fetchedFor: 'http://127.0.0.1:8080 01JSELF0000000000000000AAA' }, T0 + 2);
    expect(store.listTowerNames(db).map((n) => n.slug)).toEqual(['vm3']);
    expect(() => store.writeListing(db, { relay: null, limits: limits(), towers: [], fetchedFor: '' }, T0 + 3)).toThrow(/listing registration/);
  });
});

describe('peer store: grants', () => {
  it('stores each scope with its key shape, updates a mode in place, and removes one', () => {
    const db = freshDb();
    store.putGrant(db, { peerTowerId: PEER, scope: 'front-door', workspacePath: WS, architect: null, mode: 'deliver' }, T0);
    store.putGrant(db, { peerTowerId: PEER, scope: 'architect', workspacePath: WS, architect: 'local', mode: 'deliver' }, T0);
    store.putGrant(db, { peerTowerId: PEER, scope: 'architects', workspacePath: WS, architect: null, mode: 'hold' }, T0);
    store.putGrant(db, { peerTowerId: OTHER_PEER, scope: 'all', workspacePath: null, architect: null, mode: 'deliver' }, T0);
    const updated = store.putGrant(db, { peerTowerId: PEER, scope: 'architect', workspacePath: WS, architect: 'local', mode: 'hold' }, T0 + 5);
    expect(updated).toMatchObject({ mode: 'hold', createdAt: T0, updatedAt: T0 + 5 });
    expect(store.listGrants(db, PEER).map((g) => [g.scope, g.architect, g.mode])).toEqual([
      ['architect', 'local', 'hold'],
      ['architects', null, 'hold'],
      ['front-door', null, 'deliver'],
    ]);
    expect(store.listGrants(db, OTHER_PEER)).toEqual([
      { peerTowerId: OTHER_PEER, scope: 'all', workspacePath: null, architect: null, mode: 'deliver', createdAt: T0, updatedAt: T0 },
    ]);
    expect(store.removeGrant(db, { peerTowerId: PEER, scope: 'architects', workspacePath: WS, architect: null })).toBe(true);
    expect(store.removeGrant(db, { peerTowerId: PEER, scope: 'architects', workspacePath: WS, architect: null })).toBe(false);
    expect(store.listGrants(db)).toHaveLength(3);
  });

  it('refuses a key that does not fit its scope, and a stored value it does not know', () => {
    const db = freshDb();
    const put = (key: Partial<store.PeerGrantKey>) =>
      store.putGrant(db, { peerTowerId: PEER, scope: 'front-door', workspacePath: WS, architect: null, mode: 'deliver', ...key }, T0);
    expect(() => put({ scope: 'all' })).toThrow(/workspace/);
    expect(() => put({ workspacePath: null })).toThrow(/workspace/);
    expect(() => put({ scope: 'architect' })).toThrow(/architect/);
    expect(() => put({ architect: 'local' })).toThrow(/architect/);
    expect(() => put({ scope: 'everything' as store.PeerGrantScope })).toThrow(/grant scope/);
    db.prepare("INSERT INTO peer_grants VALUES (?, ?, 'front-door', '', 'sometimes', ?, ?)").run(PEER, WS, T0, T0);
    expect(() => store.listGrants(db)).toThrow(/grant mode/);
  });
});

describe('peer store: the outbox', () => {
  it('keeps acceptance order per peer, counts attempts, and resolves a row once', () => {
    const db = freshDb();
    const insert = (peer: string, at: number) =>
      store.insertOutbox(
        db,
        { messageId: randomUUID(), peerTowerId: peer, toAddress: 'afx://devvm/codev:architect', payload: Buffer.from(`{"n":${at}}`),
          sentAt: at, fromWorkspacePath: WS, fromAgent: null },
        at,
      );
    const a = insert(PEER, T0);
    const b = insert(OTHER_PEER, T0);
    const c = insert(PEER, T0);
    expect(store.listHeldOutbox(db, PEER).map((r) => r.messageId)).toEqual([a.messageId, c.messageId]);
    expect(store.listHeldOutbox(db).map((r) => r.messageId)).toEqual([a.messageId, b.messageId, c.messageId]);
    expect(store.getOutbox(db, a.messageId)?.payload.toString()).toBe(`{"n":${T0}}`);
    expect(store.countHeldOutbox(db, PEER)).toBe(2);

    expect(store.recordOutboxAttempt(db, a.messageId, { outcome: 'unavailable', reason: 'tower-offline', nextAttemptAt: T0 + 5000 }, T0 + 1)).toBe(true);
    expect(store.getOutbox(db, a.messageId)).toMatchObject({ attempts: 1, lastOutcome: 'unavailable', lastReason: 'tower-offline', nextAttemptAt: T0 + 5000 });
    expect(store.resolveOutbox(db, a.messageId, { state: 'accepted', outcome: 'delivered', reason: null, attempted: true }, T0 + 6000)).toBe(true);
    // The answer that resolved it replaces the last answer's pair, its null reason included.
    expect(store.getOutbox(db, a.messageId)).toMatchObject({ state: 'accepted', attempts: 2, lastOutcome: 'delivered', lastReason: null, resolvedAt: T0 + 6000, nextAttemptAt: null });
    expect(store.resolveOutbox(db, a.messageId, { state: 'refused', outcome: 'refused', reason: 'no-grant', attempted: true }, T0 + 7000)).toBe(false);
    expect(store.recordOutboxAttempt(db, a.messageId, { outcome: 'held', reason: 'busy', nextAttemptAt: T0 }, T0 + 7000)).toBe(false);
    expect(store.listHeldOutbox(db, PEER).map((r) => r.messageId)).toEqual([c.messageId]);
    expect(() => store.recordOutboxAttempt(db, c.messageId, { outcome: 'held', reason: 'Not A Token', nextAttemptAt: T0 }, T0)).toThrow(/reason/);

    // A resolution no answer made (a dismissal, an expiry) keeps the last answer's pair.
    store.recordOutboxAttempt(db, c.messageId, { outcome: 'unavailable', reason: 'no-answer', nextAttemptAt: T0 + 5000 }, T0 + 1);
    expect(() => store.resolveOutbox(db, c.messageId, { state: 'dismissed', outcome: null, reason: 'no-answer', attempted: false }, T0 + 2)).toThrow(/no answer/);
    expect(store.resolveOutbox(db, c.messageId, { state: 'dismissed', outcome: null, reason: null, attempted: false }, T0 + 2)).toBe(true);
    expect(store.getOutbox(db, c.messageId)).toMatchObject({ state: 'dismissed', attempts: 1, lastOutcome: 'unavailable', lastReason: 'no-answer' });
  });
});

describe('peer store: the record', () => {
  it('counts a flood as one row per sender, outcome, reason and minute', () => {
    const db = freshDb();
    const flood = (at: number, sender: store.PeerAggregateInput['sender']) =>
      store.countAggregate(db, { direction: 'inbound', at, sender, outcome: 'refused', reason: 'rate-limited' });
    const minute = Math.floor(T0 / 60_000) * 60_000;
    for (let i = 0; i < 1000; i++) flood(minute + (i % 60) * 1000, { peerTowerId: PEER });
    flood(minute + 60_000, { peerTowerId: PEER });
    flood(minute + 5, { tunnelSession: 'session-1' });
    const rows = store.listRecords(db);
    expect(rows.map((r) => [r.peerTowerId, r.tunnelSession, r.count, r.at, r.lastAt, r.aggregate])).toEqual([
      [PEER, null, 1, minute + 60_000, minute + 60_000, true],
      [PEER, null, 1000, minute, minute + 59_000, true],
      [null, 'session-1', 1, minute + 5, minute + 5, true],
    ]);
    const id = store.insertRecord(db, {
      direction: 'inbound', at: minute + 120_000, kind: 'message', peerTowerId: PEER, peerSlug: 'ana-s-mbp', tunnelSession: null,
      messageId: randomUUID(), fromAddress: 'codev:architect:local', toAddress: 'codev:architect', payloadSize: 120,
      outcome: 'held', reason: 'busy',
    });
    expect(store.listRecords(db, { peerTowerId: PEER, limit: 1 })).toEqual([expect.objectContaining({ id, count: 1, aggregate: false })]);
  });
});

describe('peer store: accepted-once rows', () => {
  it('refuses a held state without a reason, and a reason without held, on write and on read', () => {
    const db = freshDb();
    const row = addRemote(db);
    const base = { peerTowerId: PEER, messageId: randomUUID(), payloadSha256: 'a'.repeat(64), mailboxId: 'mbx-1', sentAt: T0 };
    expect(() => store.insertAccepted(db, { ...base, state: 'held', reason: null }, T0)).toThrow(/needs its reason/);
    expect(() => store.insertAccepted(db, { ...base, state: 'delivered', reason: 'busy' }, T0)).toThrow(/has no reason/);
    expect(() => store.mirrorAcceptedState(db, [row.id], 'held', null, T0)).toThrow(/needs its reason/);
    expect(acceptedOf(db, row)).toMatchObject({ state: 'held', reason: 'busy' });
    db.prepare("UPDATE peer_accepted SET reason = NULL WHERE mailbox_id = ?").run(row.id);
    expect(() => store.getAccepted(db, PEER, row.remote_message_id!)).toThrow(/needs its reason/);
  });

  it('names a bad payload size as a size', () => {
    const db = freshDb();
    expect(() =>
      store.insertRecord(db, {
        direction: 'outbound', at: T0, kind: 'message', peerTowerId: PEER, peerSlug: null, tunnelSession: null, messageId: null,
        fromAddress: null, toAddress: null, payloadSize: -1, outcome: 'refused', reason: 'too-large',
      }),
    ).toThrow('peer store: payload size must be a non-negative integer, got -1');
  });
});

// ===========================================================================
// Structure: the claims above stay true as the code grows
// ===========================================================================

describe('structure: held mail is read and written only in db/mailbox.ts', () => {
  const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
  /** A SQL statement that names the mailbox table. */
  const MAILBOX_STATEMENT = /\b(FROM|INTO|UPDATE|JOIN|TABLE(\s+IF\s+NOT\s+EXISTS)?)\s+mailbox\b|table_info\(mailbox\)/i;
  const ALLOWED = new Set([
    'packages/codev/src/agent-farm/db/mailbox.ts',
    'packages/codev/src/agent-farm/db/canonicalize-workspace-paths.ts',
    'packages/codev/src/agent-farm/db/schema.ts',
    'packages/codev/src/agent-farm/db/migrations.ts',
  ]);

  function productionSources(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (['__tests__', 'node_modules', 'dist'].includes(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    for (const top of ['packages', 'apps']) {
      for (const entry of readdirSync(join(REPO_ROOT, top), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          walk(join(REPO_ROOT, top, entry.name, 'src'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return files;
  }

  it('finds the statements where they are, so the check below can fail', () => {
    const own = readFileSync(join(REPO_ROOT, 'packages/codev/src/agent-farm/db/mailbox.ts'), 'utf8');
    expect(MAILBOX_STATEMENT.test(own)).toBe(true);
    expect(MAILBOX_STATEMENT.test("db.prepare(\"SELECT * FROM mailbox WHERE status = 'held'\")")).toBe(true);
    expect(MAILBOX_STATEMENT.test('const mailbox = getMailbox();')).toBe(false);
  });

  it('no other production file has a mailbox statement', () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(200);
    const offenders = files
      .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
      .filter((path) => !ALLOWED.has(path) && MAILBOX_STATEMENT.test(readFileSync(join(REPO_ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('structure: every mailbox writer is accounted for', () => {
  /** Writers that change what a duplicate is told, each with a `mirror: <name>` test above. */
  const MIRRORED: Record<string, string> = {
    INSERT_SQL: 'enqueueRemote', // the insert; local `enqueue` shares it and has no accepted-once row
    setHeldVerdict: 'setHeldVerdict',
    markDelivered: 'markDelivered',
    dismiss: 'dismiss',
    dismissHeldForAgent: 'dismissHeldForAgent',
    holdForRelease: 'holdForRelease',
    release: 'release',
  };
  /** Writers that change nothing a duplicate is told, and why. */
  const NOT_MIRRORED: Record<string, string> = {
    markEscalated: 'the escalated flag only',
    markEscalatedDelivered: 'the escalated flag only',
    dismissHeldWithKey: 'local rows only (remote_tower_id IS NULL in its statement); remote rows have no supersede_key',
    supersede: 'local rows only (remote_tower_id IS NULL in its statement); remote rows have no supersede_key',
    pruneTerminal: 'deletes the row; peer_accepted outlives it by design',
  };

  /** Each statement that writes `mailbox`, named by the top-level declaration it sits in. */
  function writingDeclarations(source: string): string[] {
    const names: string[] = [];
    const write = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mailbox\b/g;
    let match: RegExpExecArray | null;
    while ((match = write.exec(source)) !== null) {
      const before = source.slice(0, match.index);
      const declarations = [...before.matchAll(/^(?:export )?(?:function|const) (\w+)/gm)];
      names.push(declarations.length ? declarations[declarations.length - 1][1] : '<top level>');
    }
    return names;
  }

  it('classifies every writing statement in db/mailbox.ts', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/codev/src/agent-farm/db/mailbox.ts'), 'utf8');
    const found = writingDeclarations(source);
    expect(found.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(found)].sort()).toEqual([...Object.keys(MIRRORED), ...Object.keys(NOT_MIRRORED)].sort());
  });

  it('each mirrored writer has its mirror test in this file', () => {
    for (const name of Object.values(MIRRORED)) {
      expect({ name, tested: THIS_FILE.includes(`describe('mirror: ${name}'`) }).toEqual({ name, tested: true });
    }
  });

  it('would notice a new writer', () => {
    expect(writingDeclarations("export function purge(db) {\n  db.prepare('DELETE FROM mailbox').run();\n}")).toEqual(['purge']);
  });
});
