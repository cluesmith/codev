/**
 * #1574 (the real defect behind #1530): the reply mechanism is stated at the point
 * of need.
 *
 * The #1530 report — "task-lane replies silently lost" — was refuted by forensics:
 * the builder never invoked `afx send`. Told to "reply", it typed its replies as
 * plain assistant text into its own terminal, which goes nowhere by construction,
 * with zero feedback. Protocol-lane builders escape this only because porch phase
 * prompts drill `afx send architect` on every task; a task-lane builder gets a
 * minimal spawn prompt, and ANY builder loses whatever it was taught to a `/clear`.
 *
 * So the two surfaces a builder is left holding — its spawn prompt and its
 * post-refresh re-entry frame — must each name the channel themselves. These tests
 * pin the exported literals rather than paraphrases, so a rewording that drops the
 * command fails here instead of stranding a live builder.
 */

import { describe, it, expect } from 'vitest';
import { TASK_REPLY_CHANNEL } from '../commands/spawn.js';
import {
  assembleReorientation,
  REQUIRED_INLINE_MARKERS,
  type SpawnPromptPort,
} from '../commands/reset/reorient.js';
import type { ResolvedBuilderContext } from '../commands/reset/context.js';

describe('task-lane spawn prompt names the reply channel (#1574)', () => {
  it('names `afx send architect`', () => {
    expect(TASK_REPLY_CHANNEL).toContain('afx send architect');
  });

  it('says why typing a reply in its own terminal is not a reply', () => {
    // Naming the command is not enough on its own: the failure mode is a builder
    // that believes it HAS replied. The line has to contradict that belief.
    expect(TASK_REPLY_CHANNEL.toLowerCase()).toContain('reaches nobody');
  });
});

describe('re-entry frame names the reply channel (#1574)', () => {
  const STATE_PATH = '/ws/.builders/task-abc/.builder-state.md';
  const spawnPromptPort: SpawnPromptPort = () => '# Builder\n';

  function makeContext(overrides: Partial<ResolvedBuilderContext> = {}): ResolvedBuilderContext {
    return {
      builderId: 'task-abc',
      worktree: '/ws/.builders/task-abc',
      branch: 'builder/task-abc',
      protocol: 'bugfix',
      protocolSource: 'status.yaml',
      mode: 'strict',
      modeSource: 'builder-prompt',
      harnessName: 'claude',
      harness: { supportsContextReset: true } as any,
      isBareTask: false,
      ...overrides,
    } as ResolvedBuilderContext;
  }

  function assemble(overrides: Partial<ResolvedBuilderContext> = {}) {
    return assembleReorientation({
      context: makeContext(overrides),
      statePath: STATE_PATH,
      buildSpawnPrompt: spawnPromptPort,
      // A porch lane refuses to assemble without its re-entry notice (R3), so the
      // port is always supplied; the non-porch lane simply never calls it.
      buildResumeNotice: () => '## RESUME SESSION\n\nRun `porch next`.\n',
    });
  }

  it('is a REQUIRED frame element, so a frame that loses it fails assembly', () => {
    // Not merely present today: assembly validates against this list, so the
    // guarantee survives a refactor of buildInline.
    expect(REQUIRED_INLINE_MARKERS).toContain('Reply channel:');
  });

  it('states `afx send architect` inline', () => {
    const { inline } = assemble();
    expect(inline).toContain('afx send architect');
  });

  it('states it on a porch lane too, which renders a different tail of the frame', () => {
    // `buildInline` branches on `porch` for its closing step, and only there —
    // exercising the bare-task flag would re-run the identical code path and
    // document a branch that does not exist.
    const { inline } = assemble({
      porch: {
        projectId: 'bugfix-1574',
        projectName: '1574-self-attesting-frames',
        protocol: 'bugfix',
        phase: 'fix',
        statusPath: '/ws/.builders/task-abc/codev/projects/1574-x/status.yaml',
      } as ResolvedBuilderContext['porch'],
    });
    expect(inline).toContain('porch next');
    expect(inline).toContain('afx send architect');
  });
});
