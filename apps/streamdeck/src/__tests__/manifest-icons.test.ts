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
});
