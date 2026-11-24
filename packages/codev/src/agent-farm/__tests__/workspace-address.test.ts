/**
 * Spec 1940, phase 3 — the workspace naming rules (Decision 2, "Workspace names").
 *
 * `utils/workspace-address.ts` is pure: rows and the set of running workspaces go in, an
 * answer comes out. Every rule is tested here without a Tower or a database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_ADDRESS_LENGTH, parseAddress } from '@cluesmith/codev-sdk/address';
import {
  findWorkspaceByAddressName,
  isSameWorkspace,
  printableAddressName,
  validateProposedName,
  workspaceAddressName,
  WORKSPACE_NAME_COMMAND,
  type RegisteredWorkspace,
} from '../utils/workspace-address.js';
import { workspaceKey } from '../utils/workspace-path.js';
import { forceHostPlatform } from '../../__tests__/helpers/host-platform.js';

const A = '/home/ana/codev';
const B = '/home/ana/work/codev';
const CLOUD = '/home/ana/codev-cloud';
const SPACED = '/home/ana/My Notes';

function rows(...entries: Array<[string, string | null]>): RegisteredWorkspace[] {
  return entries.map(([workspacePath, explicitName]) => ({ workspacePath, explicitName }));
}

function found(name: string, registered: RegisteredWorkspace[], active: string[]): string {
  const result = findWorkspaceByAddressName(name, registered, active);
  if (!result.ok) throw new Error(`expected '${name}' to resolve, got ${result.code}: ${result.message}`);
  return result.workspacePath;
}

function refused(name: string, registered: RegisteredWorkspace[], active: string[]) {
  const result = findWorkspaceByAddressName(name, registered, active);
  if (result.ok) throw new Error(`expected '${name}' to fail, resolved to ${result.workspacePath}`);
  return result;
}

describe('findWorkspaceByAddressName', () => {
  it('compares the name lower-cased, whatever case the caller holds it in', () => {
    const registered: RegisteredWorkspace[] = [
      { workspacePath: '/w/a/codev', explicitName: 'core' },
      { workspacePath: '/w/b/Notes', explicitName: null },
    ];
    const active = ['/w/a/codev', '/w/b/Notes'];
    expect(findWorkspaceByAddressName('CORE', registered, active)).toEqual({ ok: true, workspacePath: '/w/a/codev' });
    expect(findWorkspaceByAddressName('NOTES', registered, active)).toEqual({ ok: true, workspacePath: '/w/b/Notes' });
  });

  it('finds an unnamed workspace by its basename, as before', () => {
    expect(found('codev', rows([A, null], [CLOUD, null]), [A, CLOUD])).toBe(A);
    expect(found('codev-cloud', rows([A, null], [CLOUD, null]), [A, CLOUD])).toBe(CLOUD);
  });

  it('matches a basename whatever its letter case or characters, as before', () => {
    expect(found('my notes', rows([SPACED, null]), [SPACED])).toBe(SPACED);
    expect(found('codev', rows(['/home/ana/CoDev', null]), ['/home/ana/CoDev'])).toBe('/home/ana/CoDev');
  });

  it('finds a running workspace that has no row, by its basename', () => {
    expect(found('codev', [], [A])).toBe(A);
  });

  it('fails as ambiguous for two unnamed workspaces with one basename, naming both and the remedy', () => {
    const result = refused('codev', rows([A, null], [B, null]), [A, B]);
    expect(result.code).toBe('AMBIGUOUS');
    expect(result.message).toContain(A);
    expect(result.message).toContain(B);
    expect(result.message).toContain(WORKSPACE_NAME_COMMAND);
  });

  it('resolves both once one of them is named', () => {
    const registered = rows([A, null], [B, 'work']);
    expect(found('codev', registered, [A, B])).toBe(A);
    expect(found('work', registered, [A, B])).toBe(B);
  });

  it('a workspace with an explicit name no longer answers to its basename', () => {
    const result = refused('codev-cloud', rows([CLOUD, 'cloud']), [CLOUD]);
    expect(result.code).toBe('NOT_FOUND');
    // The sender is told what the workspace is called now.
    expect(result.message).toContain(CLOUD);
    expect(result.message).toContain("'cloud'");
  });

  it('an explicit name wins over a workspace that merely has that basename', () => {
    // CLOUD was named `codev`; A, whose basename is `codev`, does not take the name.
    const registered = rows([CLOUD, 'codev'], [A, null]);
    expect(found('codev', registered, [CLOUD, A])).toBe(CLOUD);
    expect(found('codev', registered, [A, CLOUD])).toBe(CLOUD);
  });

  it('an explicit name whose workspace is not running fails saying so, and is never handed to a basename match', () => {
    const result = refused('codev', rows([CLOUD, 'codev'], [A, null]), [A]);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toContain(`Workspace 'codev' (${CLOUD}) is not running.`);
    // The running workspace with that basename is reported as needing a name of its own.
    expect(result.message).toContain(A);
    expect(result.message).toContain('a name of its own');
    expect(result.message).toContain(WORKSPACE_NAME_COMMAND);
  });

  it('an explicit name whose workspace is not running, with nothing else by that name, says only that', () => {
    const result = refused('cloud', rows([CLOUD, 'cloud']), []);
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', message: `Workspace 'cloud' (${CLOUD}) is not running.` });
  });

  it('a registered, unnamed workspace that is not running is reported as not running', () => {
    const result = refused('codev', rows([A, null]), []);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe(`Workspace 'codev' (${A}) is not running.`);
  });

  it('a stopped workspace does not make a running one with the same basename ambiguous, as before', () => {
    expect(found('codev', rows([A, null], [B, null]), [A])).toBe(A);
  });

  it('a name nothing has fails as not found', () => {
    const result = refused('nowhere', rows([A, null]), [A]);
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toContain("Workspace 'nowhere' not found");
  });

  it('clearing a name takes effect at once: the old name stops resolving and the basename returns', () => {
    const named = rows([CLOUD, 'cloud']);
    const cleared = rows([CLOUD, null]);
    expect(found('cloud', named, [CLOUD])).toBe(CLOUD);
    expect(refused('cloud', cleared, [CLOUD]).code).toBe('NOT_FOUND');
    expect(found('codev-cloud', cleared, [CLOUD])).toBe(CLOUD);
  });

  it('removing a workspace\'s row frees its name for another workspace', () => {
    expect(validateProposedName('cloud', A, rows([CLOUD, 'cloud'], [A, null]), []).ok).toBe(false);
    expect(validateProposedName('cloud', A, rows([A, null]), []).ok).toBe(true);
  });
});

describe('validateProposedName', () => {
  const registered = rows([A, null], [CLOUD, 'cloud']);

  it('accepts a name that fits, and returns it lower-cased', () => {
    expect(validateProposedName('Core-2.x_y', A, registered, [A])).toEqual({ ok: true, name: 'core-2.x_y' });
  });

  it('lower-cases before it applies the component rule, so an upper-case name is not refused for its case', () => {
    expect(validateProposedName('CORE', A, registered, [A])).toEqual({ ok: true, name: 'core' });
  });

  it.each([
    ['has a space', 'my notes'],
    ['has a colon', 'a:b'],
    ['has a slash', 'a/b'],
    ['has an at sign', 'a@b'],
    ['starts with a hyphen', '-core'],
    ['starts with a dot', '.core'],
    ['is empty', ''],
    ['has a non-ASCII letter', 'café'],
  ])('refuses a name that %s', (_why, name) => {
    const result = validateProposedName(name, A, registered, [A]);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_NAME' });
  });

  // No length limit of its own: the spec gives none. What it must be is writable in an
  // address, and the shortest address to a workspace is its front door.
  describe('a name must fit in an address (the parser decides)', () => {
    const longestThatFits = MAX_ADDRESS_LENGTH - ':architect'.length;

    it('accepts a long name', () => {
      const long = 'a'.repeat(300);
      expect(validateProposedName(long, A, registered, [A])).toEqual({ ok: true, name: long });
    });

    it('accepts the longest name whose front door the parser reads', () => {
      const name = 'a'.repeat(longestThatFits);
      expect(parseAddress(`${name}:architect`).ok).toBe(true);
      expect(validateProposedName(name, A, registered, [A])).toEqual({ ok: true, name });
    });

    it('refuses a name one character longer, saying it is too long for an address and giving the parser\'s limit', () => {
      const name = 'a'.repeat(longestThatFits + 1);
      const parsed = parseAddress(`${name}:architect`);
      expect(parsed.ok).toBe(false);
      const result = validateProposedName(name, A, registered, [A]);
      expect(result).toMatchObject({ ok: false, code: 'INVALID_NAME' });
      const { message } = result as { message: string };
      expect(message).toContain('too long to be used in an address');
      // The limit is the parser's sentence, not a number of this module's.
      expect(message).toContain((parsed as { error: { message: string } }).error.message);
      expect(message).toContain(String(MAX_ADDRESS_LENGTH));
      expect(message).toContain('<name>:architect');
      expect(message).not.toContain(name);
    });
  });

  it('cuts a long refused name short when quoting it back', () => {
    const long = `${'a'.repeat(300)} b`;
    const result = validateProposedName(long, A, registered, [A]);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_NAME' });
    expect((result as { message: string }).message).not.toContain(long);
    expect((result as { message: string }).message).toContain(`'${'a'.repeat(64)}...'`);
  });

  it('quotes a refused name as printable ASCII', () => {
    const result = validateProposedName('bad\u001b[31mname', A, registered, [A]);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).not.toContain('\u001b');
  });

  it.each(['architect', 'arch', 'builder', 'Architect', 'BUILDER'])('refuses the reserved word %s', (word) => {
    expect(validateProposedName(word, A, registered, [A])).toMatchObject({ ok: false, code: 'RESERVED_NAME' });
  });

  it('refuses the explicit name of another workspace, in any letter case', () => {
    for (const name of ['cloud', 'Cloud', 'CLOUD']) {
      const result = validateProposedName(name, A, registered, [A]);
      expect(result).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
      expect((result as { message: string }).message).toContain(CLOUD);
    }
  });

  it('refuses the basename of another unnamed workspace, in any letter case', () => {
    for (const name of ['codev', 'CoDev']) {
      const result = validateProposedName(name, CLOUD, registered, [CLOUD]);
      expect(result).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
      expect((result as { message: string }).message).toContain(A);
    }
  });

  it('says what is true of an unnamed workspace with that directory name, and how to free the name', () => {
    // CLOUD asks for `codev`, which A answers to by its directory name.
    const taken = validateProposedName('codev', CLOUD, registered, [A, CLOUD]) as { message: string };
    expect(taken.message).toBe(
      `'codev' is the directory name of the workspace ${A}, which has no name of its own. ` +
        'Choose another name, or first give that workspace one by running `afx workspace name <name>` in it.',
    );
    // B asks for `codev`, its own directory name, which A shares: neither is addressed by
    // it, so the message must not say that A is.
    const shared = validateProposedName('codev', B, rows([A, null], [B, null]), [A, B]) as { message: string };
    expect(shared).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    expect(shared.message).toContain(`is the directory name of the workspace ${A}`);
    expect(shared.message).not.toContain('already the address');
  });

  it('refuses the basename of a workspace that is registered but not running', () => {
    // A is registered and stopped: nothing is active.
    expect(validateProposedName('codev', CLOUD, registered, [])).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
  });

  it('refuses the basename of a running workspace that has no row', () => {
    expect(validateProposedName('codev', CLOUD, rows([CLOUD, null]), [A, CLOUD])).toMatchObject({
      ok: false,
      code: 'NAME_TAKEN',
    });
  });

  it('refuses a basename whose letter case differs on disk', () => {
    const result = validateProposedName('codev', CLOUD, rows(['/home/ana/CoDev', null], [CLOUD, null]), []);
    expect(result).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
  });

  it('lets a workspace keep, or set again, its own name and take its own basename', () => {
    expect(validateProposedName('cloud', CLOUD, registered, [CLOUD])).toEqual({ ok: true, name: 'cloud' });
    expect(validateProposedName('codev', A, registered, [A])).toEqual({ ok: true, name: 'codev' });
  });

  it('allows the basename of a workspace that has an explicit name: that workspace no longer answers to it', () => {
    // CLOUD is addressed as `cloud`, so `codev-cloud` is nobody's address name.
    expect(validateProposedName('codev-cloud', A, registered, [A, CLOUD])).toEqual({ ok: true, name: 'codev-cloud' });
  });
});

describe('workspaceAddressName', () => {
  it('is the explicit name when there is one', () => {
    expect(workspaceAddressName(CLOUD, rows([CLOUD, 'cloud']), [CLOUD])).toEqual({ name: 'cloud', explicit: true });
  });

  it('is the lower-cased basename otherwise, whatever characters it has', () => {
    expect(workspaceAddressName(A, rows([A, null]), [A])).toEqual({ name: 'codev', explicit: false });
    expect(workspaceAddressName(SPACED, rows([SPACED, null]), [SPACED])).toEqual({ name: 'my notes', explicit: false });
  });

  it('is the basename for a workspace Tower has no row for', () => {
    expect(workspaceAddressName(A, [], [])).toEqual({ name: 'codev', explicit: false });
  });

  it('is none for a workspace whose basename is another workspace\'s explicit name, and says it needs its own', () => {
    const result = workspaceAddressName(A, rows([CLOUD, 'codev'], [A, null]), [A]);
    expect(result.name).toBeNull();
    expect((result as { reason: string }).reason).toContain(CLOUD);
    expect((result as { reason: string }).reason).toContain('a name of its own');
    expect((result as { reason: string }).reason).toContain(WORKSPACE_NAME_COMMAND);
  });

  it('is none for a workspace that shares its basename with another running, unnamed workspace', () => {
    const result = workspaceAddressName(A, rows([A, null], [B, null]), [A, B]);
    expect(result.name).toBeNull();
    expect((result as { reason: string }).reason).toContain(B);
  });

  it('is the basename while the workspace that shares it is stopped', () => {
    expect(workspaceAddressName(A, rows([A, null], [B, null]), [A])).toEqual({ name: 'codev', explicit: false });
  });
});

describe('the two directions agree', () => {
  // Every arrangement of three workspaces, two sharing a basename, with and without names.
  const names: Array<string | null> = [null, 'codev', 'work', 'codev-cloud'];
  const arrangements: RegisteredWorkspace[][] = [];
  for (const a of names) {
    for (const b of names) {
      for (const c of names) {
        const explicit = [a, b, c].filter((n) => n !== null);
        if (new Set(explicit).size !== explicit.length) continue; // explicit names are unique
        arrangements.push(rows([A, a], [B, b], [CLOUD, c]));
      }
    }
  }
  const activeSets = [[A, B, CLOUD], [A, CLOUD], [B], []];

  it('a workspace\'s own name resolves to it while it runs, and a workspace with none is reached by no name', () => {
    for (const registered of arrangements) {
      for (const active of activeSets) {
        for (const workspacePath of active) {
          const own = workspaceAddressName(workspacePath, registered, active);
          const context = JSON.stringify({ registered, active, workspacePath });
          if (own.name !== null) {
            expect(findWorkspaceByAddressName(own.name, registered, active), context).toEqual({ ok: true, workspacePath });
          } else {
            for (const name of ['codev', 'work', 'codev-cloud']) {
              const lookup = findWorkspaceByAddressName(name, registered, active);
              expect(lookup.ok && lookup.workspacePath === workspacePath, context).toBe(false);
            }
          }
        }
      }
    }
  });

  it('a name that validation accepts never changes where an existing name resolves', () => {
    for (const registered of arrangements) {
      const active = [A, B, CLOUD];
      for (const candidate of ['codev', 'work', 'codev-cloud', 'fresh']) {
        const checked = validateProposedName(candidate, A, registered, active);
        if (!checked.ok) continue;
        const after = registered.map((w) => (w.workspacePath === A ? { ...w, explicitName: checked.name } : w));
        for (const other of [B, CLOUD]) {
          const before = workspaceAddressName(other, registered, active);
          if (before.name === null) continue;
          expect(
            findWorkspaceByAddressName(before.name, after, active),
            JSON.stringify({ registered, candidate, other }),
          ).toEqual({ ok: true, workspacePath: other });
        }
      }
    }
  });
});

// Workspaces are told apart by their key, never by the text of a path (on Windows the key
// is the canonical spelling). A row and a running workspace that spell one directory two
// ways are ONE workspace, with the row's name.
describe('one workspace under two spellings of its path (Windows keys)', () => {
  const ROW = 'c:/nx-spec-1940/a/codev';
  const LIVE = 'C:/nx-spec-1940/a/codev';
  const OTHER = 'C:/nx-spec-1940/b/other';
  const registered: RegisteredWorkspace[] = [
    { workspacePath: ROW, explicitName: 'core' },
    { workspacePath: OTHER, explicitName: null },
  ];
  const active = [LIVE, OTHER];

  beforeEach(() => {
    forceHostPlatform('win32');
    expect(workspaceKey(ROW)).toBe(workspaceKey(LIVE));
    expect(ROW).not.toBe(LIVE);
  });

  it('its name reaches it, in the spelling it runs under (the key of the live terminal map)', () => {
    expect(findWorkspaceByAddressName('core', registered, active)).toEqual({ ok: true, workspacePath: LIVE });
  });

  it('it does not also answer to its directory name as a second, unnamed workspace', () => {
    const result = findWorkspaceByAddressName('codev', registered, active);
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((result as { message: string }).message).toContain("addressed as 'core'");
  });

  it('its directory name is free for another workspace, as for any renamed workspace', () => {
    expect(validateProposedName('codev', OTHER, registered, active)).toEqual({ ok: true, name: 'codev' });
  });

  it('its own name is its explicit name, under either spelling', () => {
    for (const spelling of [ROW, LIVE]) {
      expect(workspaceAddressName(spelling, registered, active)).toEqual({ name: 'core', explicit: true });
    }
  });

  it('it may set the name it already has, under either spelling', () => {
    for (const spelling of [ROW, LIVE]) {
      expect(validateProposedName('core', spelling, registered, active)).toEqual({ ok: true, name: 'core' });
    }
  });

  // Two ROWS for one directory: only a table read before boot canonicalization merged
  // them can hold that. Which name the workspace has is fixed, and said in `everyWorkspace`.
  describe('and two rows for it', () => {
    it('takes the name of the later row that has one', () => {
      const two = [
        { workspacePath: ROW, explicitName: 'core' },
        { workspacePath: LIVE, explicitName: 'kernel' },
      ];
      expect(workspaceAddressName(LIVE, two, [LIVE])).toEqual({ name: 'kernel', explicit: true });
      expect(findWorkspaceByAddressName('kernel', two, [LIVE])).toEqual({ ok: true, workspacePath: LIVE });
      // The earlier name refers to no workspace until the rows are merged.
      expect(findWorkspaceByAddressName('core', two, [LIVE])).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('a later row with no name does not clear the earlier row\'s', () => {
      const two = [
        { workspacePath: ROW, explicitName: 'core' },
        { workspacePath: LIVE, explicitName: null },
      ];
      expect(workspaceAddressName(LIVE, two, [LIVE])).toEqual({ name: 'core', explicit: true });
    });
  });
});

describe('printableAddressName', () => {
  it('is the address name when that can be written in an address', () => {
    expect(printableAddressName(A, rows([A, null]), [A])).toEqual({ name: 'codev', explicit: false });
    expect(printableAddressName(CLOUD, rows([CLOUD, 'cloud']), [CLOUD])).toEqual({ name: 'cloud', explicit: true });
  });

  it('is none, for the same reason, when the workspace has no address name', () => {
    const registered = rows([A, null], [B, null]);
    expect(printableAddressName(A, registered, [A, B])).toEqual(workspaceAddressName(A, registered, [A, B]));
    expect(printableAddressName(A, registered, [A, B]).name).toBeNull();
  });

  it.each([
    ['a space', '/home/ana/My Notes'],
    ['a colon', '/home/ana/a:b'],
    ['a leading dot', '/home/ana/.config'],
    ['a letter outside ASCII', '/home/ana/café'],
  ])('is none for a directory name with %s, and names the remedy', (_what, workspacePath) => {
    // The resolver still matches such a name (a local address matches any basename); it is
    // only never PRINTED as one.
    expect(workspaceAddressName(workspacePath, rows([workspacePath, null]), [workspacePath]).name).not.toBeNull();
    const result = printableAddressName(workspacePath, rows([workspacePath, null]), [workspacePath]);
    expect(result.name).toBeNull();
    expect((result as { reason: string }).reason).toContain('cannot be written in an address');
    expect((result as { reason: string }).reason).toContain(WORKSPACE_NAME_COMMAND);
  });

  it('quotes a directory name it refuses as printable ASCII', () => {
    const escape = '/home/ana/bad\u001b[31mname';
    const result = printableAddressName(escape, rows([escape, null]), [escape]);
    expect((result as { reason: string }).reason).not.toContain('\u001b');
  });

  it('accepts every name validateProposedName accepts: an explicit name is always printable', () => {
    for (const name of ['core', 'a', 'x.y_z-1', '9lives']) {
      expect(validateProposedName(name, A, rows([A, null]), [A])).toEqual({ ok: true, name });
      expect(printableAddressName(A, rows([A, name]), [A])).toEqual({ name, explicit: true });
    }
  });
});

describe('isSameWorkspace', () => {
  it('compares workspace keys', () => {
    expect(isSameWorkspace(A, A)).toBe(true);
    expect(isSameWorkspace(A, B)).toBe(false);
  });
});
