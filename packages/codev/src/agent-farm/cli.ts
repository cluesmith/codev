/**
 * Agent Farm CLI wrapper
 *
 * This module re-exports the agent-farm CLI logic so it can be invoked
 * programmatically from the main codev CLI.
 */

import { Command } from 'commander';
import { start, stop } from './commands/index.js';
import { logger } from './utils/logger.js';
import { getResolvedCommands, setCliOverrides, initializePorts } from './utils/config.js';
import { version } from '../version.js';

/**
 * Run agent-farm CLI with given arguments
 */
export async function runAgentFarm(args: string[]): Promise<void> {
  const program = new Command();

  program
    .name('af')
    .description('Agent Farm - Multi-agent orchestration for software development')
    .version(version);

  // Global options for command overrides
  program
    .option('--architect-cmd <command>', 'Override architect command')
    .option('--builder-cmd <command>', 'Override builder command')
    .option('--shell-cmd <command>', 'Override shell command');

  // Process global options before commands
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    const overrides: Record<string, string> = {};

    if (opts.architectCmd) overrides.architect = opts.architectCmd;
    if (opts.builderCmd) overrides.builder = opts.builderCmd;
    if (opts.shellCmd) overrides.shell = opts.shellCmd;

    if (Object.keys(overrides).length > 0) {
      setCliOverrides(overrides);
    }

    initializePorts();
  });

  // Start command
  program
    .command('start')
    .description('Start the architect dashboard')
    .option('-c, --cmd <command>', 'Command to run in architect terminal')
    .option('-p, --port <port>', 'Port for architect terminal')
    .option('--no-role', 'Skip loading architect role prompt')
    .option('--allow-insecure-remote', 'Bind to 0.0.0.0 for remote access (WARNING: no auth)')
    .action(async (options) => {
      try {
        const commands = getResolvedCommands();
        await start({
          cmd: options.cmd || commands.architect,
          port: options.port ? parseInt(options.port, 10) : undefined,
          noRole: !options.role,
          allowInsecureRemote: options.allowInsecureRemote,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Stop command
  program
    .command('stop')
    .description('Stop all agent farm processes')
    .action(async () => {
      try {
        await stop();
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Architect command - direct CLI access
  program
    .command('architect [args...]')
    .description('Start or attach to architect tmux session (power user mode)')
    .action(async (args: string[]) => {
      const { architect } = await import('./commands/architect.js');
      try {
        await architect({ args });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Status command
  program
    .command('status')
    .description('Show status of all agents')
    .action(async () => {
      const { status } = await import('./commands/status.js');
      try {
        await status();
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Spawn command
  program
    .command('spawn')
    .description('Spawn a new builder')
    .option('-p, --project <id>', 'Spawn builder for a spec')
    .option('--task <text>', 'Spawn builder with a task description')
    .option('--protocol <name>', 'Spawn builder to run a protocol')
    .option('--shell', 'Spawn a bare Claude session')
    .option('--worktree', 'Spawn worktree session')
    .option('--files <files>', 'Context files (comma-separated)')
    .option('--no-role', 'Skip loading role prompt')
    .action(async (options) => {
      const { spawn } = await import('./commands/spawn.js');
      try {
        const files = options.files ? options.files.split(',').map((f: string) => f.trim()) : undefined;
        await spawn({
          project: options.project,
          task: options.task,
          protocol: options.protocol,
          shell: options.shell,
          worktree: options.worktree,
          files,
          noRole: !options.role,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Util/Shell command
  program
    .command('util')
    .alias('shell')
    .description('Spawn a utility shell terminal')
    .option('-n, --name <name>', 'Name for the shell terminal')
    .action(async (options) => {
      const { util } = await import('./commands/util.js');
      try {
        await util({ name: options.name });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Consult command - runs consult in a dashboard terminal
  program
    .command('consult <subcommand> <target>')
    .description('Run consult command in a dashboard terminal')
    .requiredOption('-m, --model <model>', 'Model to use (gemini, codex, claude)')
    .option('-t, --type <type>', 'Review type (spec-review, plan-review, impl-review, pr-ready, integration-review)')
    .action(async (subcommand, target, options) => {
      const { consult } = await import('./commands/consult.js');
      try {
        await consult(subcommand, target, {
          model: options.model,
          type: options.type,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Open command
  program
    .command('open <file>')
    .description('Open file annotation viewer')
    .action(async (file) => {
      const { open } = await import('./commands/open.js');
      try {
        await open({ file });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Cleanup command
  program
    .command('cleanup')
    .description('Clean up a builder worktree and branch')
    .requiredOption('-p, --project <id>', 'Builder ID to clean up')
    .option('-f, --force', 'Force cleanup even if branch not merged')
    .action(async (options) => {
      const { cleanup } = await import('./commands/cleanup.js');
      try {
        await cleanup({ project: options.project, force: options.force });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Rename command
  program
    .command('rename <id> <name>')
    .description('Rename a builder or utility terminal')
    .action(async (id, name) => {
      const { rename } = await import('./commands/rename.js');
      try {
        rename({ id, name });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Send command
  program
    .command('send [builder] [message]')
    .description('Send instructions to a running builder')
    .option('--all', 'Send to all builders')
    .option('--file <path>', 'Include file content in message')
    .option('--interrupt', 'Send Ctrl+C first')
    .option('--raw', 'Skip structured message formatting')
    .option('--no-enter', 'Do not send Enter after message')
    .action(async (builder, message, options) => {
      const { send } = await import('./commands/send.js');
      try {
        await send({
          builder,
          message,
          all: options.all,
          file: options.file,
          interrupt: options.interrupt,
          raw: options.raw,
          noEnter: !options.enter,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Ports command
  const portsCmd = program
    .command('ports')
    .description('Manage global port registry');

  portsCmd
    .command('list')
    .description('List all port allocations')
    .action(async () => {
      const { listAllocations } = await import('./utils/port-registry.js');
      const allocations = listAllocations();

      if (allocations.length === 0) {
        logger.info('No port allocations found.');
        return;
      }

      logger.header('Port Allocations');
      for (const alloc of allocations) {
        const status = alloc.exists ? '' : ' (missing)';
        logger.info(`${alloc.basePort}-${alloc.basePort + 99}: ${alloc.path}${status}`);
      }
    });

  portsCmd
    .command('cleanup')
    .description('Remove stale port allocations')
    .action(async () => {
      const { cleanupStaleEntries } = await import('./utils/port-registry.js');
      const result = cleanupStaleEntries();

      if (result.removed.length === 0) {
        logger.info('No stale entries found.');
      } else {
        logger.success(`Removed ${result.removed.length} stale entries:`);
        for (const path of result.removed) {
          logger.info(`  - ${path}`);
        }
      }
      logger.info(`Remaining allocations: ${result.remaining}`);
    });

  // Tutorial command
  program
    .command('tutorial')
    .description('Interactive tutorial for new users')
    .option('--reset', 'Start tutorial fresh')
    .option('--skip', 'Skip current step')
    .option('--status', 'Show tutorial progress')
    .action(async (options) => {
      const { tutorial } = await import('./commands/tutorial.js');
      try {
        await tutorial(options);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Database commands
  const dbCmd = program
    .command('db')
    .description('Database debugging and maintenance');

  dbCmd
    .command('dump')
    .description('Export all tables to JSON')
    .option('--global', 'Dump global.db')
    .action(async (options) => {
      const { dbDump } = await import('./commands/db.js');
      try {
        dbDump({ global: options.global });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  dbCmd
    .command('query <sql>')
    .description('Run a SELECT query')
    .option('--global', 'Query global.db')
    .action(async (sql, options) => {
      const { dbQuery } = await import('./commands/db.js');
      try {
        dbQuery(sql, { global: options.global });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  dbCmd
    .command('reset')
    .description('Delete database and start fresh')
    .option('--global', 'Reset global.db')
    .option('--force', 'Skip confirmation')
    .action(async (options) => {
      const { dbReset } = await import('./commands/db.js');
      try {
        dbReset({ global: options.global, force: options.force });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  dbCmd
    .command('stats')
    .description('Show database statistics')
    .option('--global', 'Show stats for global.db')
    .action(async (options) => {
      const { dbStats } = await import('./commands/db.js');
      try {
        dbStats({ global: options.global });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Parse with provided args
  await program.parseAsync(['node', 'af', ...args]);
}
