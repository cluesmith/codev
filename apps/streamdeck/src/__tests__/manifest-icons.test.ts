import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #1440: the `send-queue` and `open-terminal` actions got dedicated icons rendered from the
 * face.ts glyph vectors, replacing the shared `action` asset they used to borrow. These guards
 * keep the manifest and the on-disk PNGs in agreement: a manifest that points at a missing or
 * deleted image reverts the key to a blank in the Stream Deck app (and fails Elgato validation),
 * so pin every referenced asset to a real file — and pin the two follow-up actions to their own.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginDir = join(root, 'com.cluesmith.codev.sdPlugin');

interface ManifestAction {
  UUID: string;
  Icon: string;
  States: { Image: string }[];
}
const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf-8')) as {
  Icon: string;
  CategoryIcon: string;
  Actions: ManifestAction[];
};

/** A manifest icon reference (no extension) → the @1x and @2x PNGs it must resolve to. */
function pngVariants(ref: string): string[] {
  return [join(pluginDir, `${ref}.png`), join(pluginDir, `${ref}@2x.png`)];
}

/** Read a PNG's pixel dimensions from its IHDR chunk (bytes 16–24, big-endian) — no image lib. */
function pngSize(absPath: string): { w: number; h: number } {
  const buf = readFileSync(absPath);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('manifest icon assets exist on disk', () => {
  const refs = new Set<string>([manifest.Icon, manifest.CategoryIcon]);
  for (const action of manifest.Actions) {
    refs.add(action.Icon);
    for (const state of action.States) refs.add(state.Image);
  }

  for (const ref of refs) {
    it(`${ref} resolves to @1x and @2x PNGs`, () => {
      for (const png of pngVariants(ref)) {
        expect(existsSync(png), `missing ${png}`).toBe(true);
      }
    });
  }
});

describe('#1440 dedicated action icons', () => {
  function action(uuid: string): ManifestAction {
    const found = manifest.Actions.find((a) => a.UUID === uuid);
    if (!found) throw new Error(`action ${uuid} not in manifest`);
    return found;
  }

  it('send-queue points at its own icon, not the shared action asset', () => {
    const a = action('com.cluesmith.codev.send-queue');
    expect(a.Icon).toBe('icons/list/send-queue');
    expect(a.States[0].Image).toBe('icons/send-queue');
  });

  it('open-terminal points at its own icon, not the shared action asset', () => {
    const a = action('com.cluesmith.codev.open-terminal');
    expect(a.Icon).toBe('icons/list/open-terminal');
    expect(a.States[0].Image).toBe('icons/open-terminal');
  });

  it('removes the verified-dead icons (approve-gate-empty / -pending / gate-nav)', () => {
    const dead = ['icons/approve-gate-empty', 'icons/approve-gate-pending', 'icons/gate-nav'];
    for (const ref of dead) {
      for (const png of pngVariants(ref)) {
        expect(existsSync(png), `${png} should have been deleted`).toBe(false);
      }
    }
  });

  it('keeps the still-live approve-gate assets', () => {
    for (const ref of ['icons/approve-gate', 'icons/list/approve-gate']) {
      for (const png of pngVariants(ref)) {
        expect(existsSync(png), `missing ${png}`).toBe(true);
      }
    }
  });

  // The Stream Deck convention: key Image @1x/@2x = 72/144, list Icon @1x/@2x = 20/40. A wrongly
  // sized asset renders blurry or gets rejected by Elgato validation — pin the committed sizes.
  it.each(['send-queue', 'open-terminal'])('%s icons ship at the convention sizes', (name) => {
    expect(pngSize(join(pluginDir, `icons/${name}.png`))).toEqual({ w: 72, h: 72 });
    expect(pngSize(join(pluginDir, `icons/${name}@2x.png`))).toEqual({ w: 144, h: 144 });
    expect(pngSize(join(pluginDir, `icons/list/${name}.png`))).toEqual({ w: 20, h: 20 });
    expect(pngSize(join(pluginDir, `icons/list/${name}@2x.png`))).toEqual({ w: 40, h: 40 });
  });
});

/**
 * #1444: the catch-all `Codev Action` was re-glyphed off the terminal picture (which now belongs to
 * the dedicated open-terminal action from #1440) onto the Codev brand mark. Its manifest references
 * are unchanged — only the pixels behind `icons/action` were regenerated — so these guards pin both
 * the still-shared filenames and the fix itself: the action image must no longer be the terminal.
 */
describe('#1444 re-glyphed Codev Action', () => {
  function action(uuid: string): ManifestAction {
    const found = manifest.Actions.find((a) => a.UUID === uuid);
    if (!found) throw new Error(`action ${uuid} not in manifest`);
    return found;
  }

  it('keeps the action referencing its own icon filenames', () => {
    const a = action('com.cluesmith.codev.action');
    expect(a.Icon).toBe('icons/list/action');
    expect(a.States[0].Image).toBe('icons/action');
  });

  it('action icons ship at the convention sizes', () => {
    expect(pngSize(join(pluginDir, 'icons/action.png'))).toEqual({ w: 72, h: 72 });
    expect(pngSize(join(pluginDir, 'icons/action@2x.png'))).toEqual({ w: 144, h: 144 });
    expect(pngSize(join(pluginDir, 'icons/list/action.png'))).toEqual({ w: 20, h: 20 });
    expect(pngSize(join(pluginDir, 'icons/list/action@2x.png'))).toEqual({ w: 40, h: 40 });
  });

  // The collision the issue reports: before the re-glyph, action and open-terminal drew the same
  // terminal picture. The two key faces must no longer be byte-identical.
  it.each(['icons/action.png', 'icons/action@2x.png', 'icons/list/action.png', 'icons/list/action@2x.png'])(
    '%s no longer collides with the open-terminal asset',
    (ref) => {
      const terminalRef = ref.replace('action', 'open-terminal');
      const actionBytes = readFileSync(join(pluginDir, ref));
      const terminalBytes = readFileSync(join(pluginDir, terminalRef));
      expect(actionBytes.equals(terminalBytes)).toBe(false);
    },
  );
});
