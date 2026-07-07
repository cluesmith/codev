/**
 * The #1144 layer model: IDE-mode detection and the activation policy per
 * quadrant of the issue's behavior matrix.
 *
 * The dormant column being all-false IS the marketplace-inertness guarantee:
 * with `onStartupFinished` in activationEvents, activate() runs in every
 * window of every install, and `activationPolicy('dormant')` is the only
 * thing standing between a vanilla VS Code window and a spawned Tower
 * process / stolen focus / state writes.
 */

import { describe, it, expect } from 'vitest';
import {
  CODEV_IDE_APP_NAME,
  detectIdeMode,
  decideActivationTier,
  activationPolicy,
} from '../ide-mode.js';

describe('detectIdeMode', () => {
  it('matches the fork appName exactly', () => {
    expect(detectIdeMode({ appName: CODEV_IDE_APP_NAME, isDevelopment: false })).toBe(true);
  });

  it.each(['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'VSCodium', ''])(
    'is guest mode under %j',
    (appName) => {
      expect(detectIdeMode({ appName, isDevelopment: false })).toBe(false);
    },
  );

  it('does not prefix/suffix-match the contract string', () => {
    expect(detectIdeMode({ appName: `${CODEV_IDE_APP_NAME} Nightly`, isDevelopment: false })).toBe(false);
    expect(detectIdeMode({ appName: ` ${CODEV_IDE_APP_NAME}`, isDevelopment: false })).toBe(false);
  });

  it('honors the simulation seam in Development mode only', () => {
    const guest = 'Visual Studio Code';
    expect(detectIdeMode({ appName: guest, isDevelopment: true, simulationSeam: '1' })).toBe(true);
    // A production install can never be flipped by the environment.
    expect(detectIdeMode({ appName: guest, isDevelopment: false, simulationSeam: '1' })).toBe(false);
    // The seam requires the exact value '1'.
    expect(detectIdeMode({ appName: guest, isDevelopment: true, simulationSeam: 'true' })).toBe(false);
    expect(detectIdeMode({ appName: guest, isDevelopment: true, simulationSeam: undefined })).toBe(false);
  });
});

describe('decideActivationTier', () => {
  it('is full whenever a codev workspace is present, in guest and IDE alike', () => {
    expect(decideActivationTier({ ideMode: false, hasCodevWorkspace: true })).toBe('full');
    expect(decideActivationTier({ ideMode: true, hasCodevWorkspace: true })).toBe('full');
  });

  it('is ide-empty for the IDE with no codev workspace', () => {
    expect(decideActivationTier({ ideMode: true, hasCodevWorkspace: false })).toBe('ide-empty');
  });

  it('is dormant for guest mode with no codev workspace', () => {
    expect(decideActivationTier({ ideMode: false, hasCodevWorkspace: false })).toBe('dormant');
  });
});

describe('activationPolicy — the behavior matrix, one quadrant at a time', () => {
  it('guest + no codev workspace (dormant): every side effect is off', () => {
    expect(activationPolicy('dormant')).toEqual({
      initializeConnection: false,
      runPreflight: false,
      revealPanelOnce: false,
      showStatusBar: false,
      writeCleanupState: false,
      focusCodevContainer: false,
      ideFirstRun: false,
    });
  });

  it('codev workspace (full, guest or IDE): today\'s behavior, no IDE onboarding', () => {
    expect(activationPolicy('full')).toEqual({
      initializeConnection: true,
      runPreflight: true,
      revealPanelOnce: true,
      showStatusBar: true,
      writeCleanupState: true,
      focusCodevContainer: false,
      ideFirstRun: false,
    });
  });

  it('IDE + no workspace (ide-empty): Tower-level surfaces live + onboarding', () => {
    expect(activationPolicy('ide-empty')).toEqual({
      initializeConnection: true,
      runPreflight: true,
      revealPanelOnce: true,
      showStatusBar: true,
      writeCleanupState: true,
      focusCodevContainer: true,
      ideFirstRun: true,
    });
  });
});
