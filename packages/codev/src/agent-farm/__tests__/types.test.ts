/**
 * Tests for TypeScript types - compile-time checks
 */

import { describe, it, expect } from 'vitest';
import type {
  Builder,
  UtilTerminal,
  Annotation,
  ArchitectState,
  DashboardState,
  Config,
  StartOptions,
  SpawnOptions,
} from '../types.js';

describe('Type Definitions', () => {
  describe('Builder', () => {
    it('should accept valid builder objects', () => {
      const builder: Builder = {
        id: 'B001',
        name: 'test-builder',
        port: 7681,
        pid: 1234,
        status: 'implementing',
        phase: 'planning',
        worktree: '/path/to/worktree',
        branch: 'builder/0001-test',
        type: 'spec',
      };

      expect(builder.id).toBe('B001');
      expect(builder.status).toBe('implementing');
      expect(builder.type).toBe('spec');
    });

    it('should enforce status enum', () => {
      const validStatuses: Builder['status'][] = [
        'spawning',
        'implementing',
        'blocked',
        'pr-ready',
        'complete',
      ];

      validStatuses.forEach((status) => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('UtilTerminal', () => {
    it('should accept valid util terminal objects', () => {
      const util: UtilTerminal = {
        id: 'U001',
        name: 'my-util',
        port: 7700,
        pid: 5678,
      };

      expect(util.id).toBe('U001');
      expect(util.port).toBe(7700);
    });
  });

  describe('Annotation', () => {
    it('should accept valid annotation objects', () => {
      const annotation: Annotation = {
        id: 'A001',
        file: '/path/to/file.ts',
        port: 8080,
        pid: 9012,
        parent: {
          type: 'architect',
        },
      };

      expect(annotation.id).toBe('A001');
      expect(annotation.parent.type).toBe('architect');
    });

    it('should allow parent with builder id', () => {
      const annotation: Annotation = {
        id: 'A002',
        file: '/path/to/file.ts',
        port: 8081,
        pid: 9013,
        parent: {
          type: 'builder',
          id: 'B001',
        },
      };

      expect(annotation.parent.type).toBe('builder');
      expect(annotation.parent.id).toBe('B001');
    });
  });

  describe('DashboardState', () => {
    it('should accept valid dashboard state', () => {
      const state: DashboardState = {
        architect: {
          port: 7680,
          pid: 1111,
          cmd: 'claude',
          startedAt: '2024-01-01T00:00:00Z',
        },
        builders: [],
        utils: [],
        annotations: [],
      };

      expect(state.architect?.port).toBe(7680);
      expect(state.builders).toHaveLength(0);
    });

    it('should allow null architect', () => {
      const state: DashboardState = {
        architect: null,
        builders: [],
        utils: [],
        annotations: [],
      };

      expect(state.architect).toBeNull();
    });
  });

  describe('Config', () => {
    it('should accept valid config objects', () => {
      const config: Config = {
        projectRoot: '/path/to/project',
        codevDir: '/path/to/project/codev',
        buildersDir: '/path/to/project/.builders',
        stateDir: '/path/to/project/.agent-farm',
        templatesDir: '/path/to/templates',
        serversDir: '/path/to/servers',
        bundledRolesDir: '/path/to/roles',
      };

      expect(config.projectRoot).toBe('/path/to/project');
      expect(config.codevDir).toBe('/path/to/project/codev');
      expect(config.buildersDir).toBe('/path/to/project/.builders');
    });
  });

  describe('StartOptions', () => {
    it('should accept optional cmd and port', () => {
      const options1: StartOptions = {};
      const options2: StartOptions = { cmd: 'claude' };
      const options3: StartOptions = { port: 7680 };
      const options4: StartOptions = { cmd: 'claude', port: 7680 };

      expect(options1.cmd).toBeUndefined();
      expect(options2.cmd).toBe('claude');
      expect(options3.port).toBe(7680);
      expect(options4.cmd).toBe('claude');
    });
  });

  describe('SpawnOptions', () => {
    it('should accept project mode (spec)', () => {
      const options: SpawnOptions = {
        project: '0005',
      };

      expect(options.project).toBe('0005');
    });

    it('should accept task mode', () => {
      const options: SpawnOptions = {
        task: 'Fix the login bug',
        files: ['src/auth.ts', 'src/login.ts'],
      };

      expect(options.task).toBe('Fix the login bug');
      expect(options.files).toHaveLength(2);
    });

    it('should accept protocol mode', () => {
      const options: SpawnOptions = {
        protocol: 'cleanup',
      };

      expect(options.protocol).toBe('cleanup');
    });

    it('should accept shell mode', () => {
      const options: SpawnOptions = {
        shell: true,
      };

      expect(options.shell).toBe(true);
    });

    it('should accept worktree mode', () => {
      const options: SpawnOptions = {
        worktree: true,
      };

      expect(options.worktree).toBe(true);
    });
  });
});
