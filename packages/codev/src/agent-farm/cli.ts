/**
 * Agent Farm CLI wrapper
 *
 * This module re-exports the agent-farm CLI logic so it can be invoked
 * programmatically from the main codev CLI.
 */

import { Command } from 'commander';
import { start, stop } from './commands/index.js';
import { towerStart, towerStop, towerLog } from './commands/tower.js';
import { towerRegister, towerDeregister, towerCloudStatus } from './commands/tower-cloud.js';
import { logger } from './utils/logger.js';
import { setCliOverrides } from './utils/config.js';
import { version } from '../version.js';

/**
 * Show tower daemon status and cloud connection info.
 */
async function towerStatus(port?: number): Promise<void> {
  const towerPort = port || 4100;

  logger.header('Tower Status');

  // Check if daemon is running and show instance details
  try {
    const response = await fetch(`http://127.0.0.1:${towerPort}/api/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      logger.kv('Daemon', `running on port ${towerPort}`);
      const data = (await response.json()) as {
        instances?: Array<{ workspaceName: string; running: boolean; terminals: unknown[] }>;
      };
      if (data.instances) {
        const running = data.instances.filter((i) => i.running);
        const totalTerminals = data.instances.reduce((sum, i) => sum + (i.terminals?.length || 0), 0);
        logger.kv('Workspaces', `${running.length} active / ${data.instances.length} total`);
        logger.kv('Terminals', `${totalTerminals}`);
      }
    } else {
      logger.kv('Daemon', 'not responding');
    }
  } catch {
    logger.kv('Daemon', 'not running');
  }

  // Show cloud connection status
  await towerCloudStatus(towerPort);
}

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
  });

  // Dashboard command group (project-level dashboard)
  const dashCmd = program
    .command('dash')
    .description('Project dashboard - start/stop the architect dashboard for this project');

  dashCmd
    .command('start')
    .description('Start the architect dashboard')
    .option('--no-browser', 'Skip opening browser after start')
    .action(async (options) => {
      try {
        await start({
          noBrowser: !options.browser,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  dashCmd
    .command('stop')
    .description('Stop all agent farm processes for this project')
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
    .description('Start or attach to architect session (power user mode)')
    .option('-l, --layout', 'Create multi-pane layout with status and shell')
    .action(async (args: string[], options: { layout?: boolean }) => {
      const { architect } = await import('./commands/architect.js');
      try {
        await architect({ args, layout: options.layout });
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

  // Attach command
  program
    .command('attach')
    .description('Attach to a running builder terminal')
    .option('-p, --project <id>', 'Builder ID / project ID to attach to')
    .option('-i, --issue <number>', 'Issue number (for bugfix builders)')
    .option('-b, --browser', 'Open in browser')
    .action(async (options) => {
      const { attach } = await import('./commands/attach.js');
      try {
        const issue = options.issue ? parseInt(options.issue, 10) : undefined;
        await attach({
          project: options.project,
          issue,
          browser: options.browser,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Spawn command
  const spawnCmd = program
    .command('spawn')
    .description('Spawn a new builder')
    .argument('[number]', 'Issue number (positional)')
    .option('--protocol <name>', 'Protocol to use (spir, bugfix, tick, maintain, experiment)')
    .option('--task <text>', 'Spawn builder with a task description')
    .option('--shell', 'Spawn a bare Claude session')
    .option('--worktree', 'Spawn worktree session')
    .option('--amends <number>', 'Original spec number for TICK amendments')
    .option('--files <files>', 'Context files (comma-separated)')
    .option('--no-comment', 'Skip commenting on issue')
    .option('--force', 'Skip safety checks (dirty worktree, collision detection)')
    .option('--soft', 'Use soft mode (AI follows protocol, you verify compliance)')
    .option('--strict', 'Use strict mode (porch orchestrates)')
    .option('--resume', 'Resume builder in existing worktree (skip worktree creation)')
    .option('--no-role', 'Skip loading role prompt');

  // Catch removed flags with helpful migration messages
  spawnCmd.hook('preAction', (_thisCmd, actionCmd) => {
    const rawArgs = actionCmd.args || [];
    const allArgs = process.argv.slice(2);
    for (const arg of allArgs) {
      if (arg === '-p' || arg === '--project') {
        logger.error(`"${arg}" has been removed. Use a positional argument instead:\n  af spawn 315 --protocol spir`);
        process.exit(1);
      }
      if (arg === '-i' || arg === '--issue') {
        logger.error(`"${arg}" has been removed. Use a positional argument instead:\n  af spawn 315 --protocol bugfix`);
        process.exit(1);
      }
    }
  });

  spawnCmd.action(async (numberArg: string | undefined, options: Record<string, unknown>) => {
      const { spawn } = await import('./commands/spawn.js');
      try {
        const files = options.files ? (options.files as string).split(',').map((f: string) => f.trim()) : undefined;
        const issueNumber = numberArg ? parseInt(numberArg, 10) : undefined;
        if (numberArg && (isNaN(issueNumber!) || issueNumber! <= 0)) {
          logger.error(`Invalid issue number: ${numberArg}`);
          process.exit(1);
        }
        const amends = options.amends ? parseInt(options.amends as string, 10) : undefined;
        await spawn({
          issueNumber,
          protocol: options.protocol as string | undefined,
          task: options.task as string | undefined,
          shell: options.shell as boolean | undefined,
          worktree: options.worktree as boolean | undefined,
          amends,
          files,
          noComment: !(options.comment as boolean),
          force: options.force as boolean | undefined,
          soft: options.soft as boolean | undefined,
          strict: options.strict as boolean | undefined,
          resume: options.resume as boolean | undefined,
          noRole: !(options.role as boolean),
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Shell command
  program
    .command('shell')
    .description('Spawn a utility shell terminal')
    .option('-n, --name <name>', 'Name for the shell terminal')
    .action(async (options) => {
      const { shell } = await import('./commands/shell.js');
      try {
        await shell({ name: options.name });
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
    .option('-p, --project <id>', 'Builder ID to clean up')
    .option('-i, --issue <number>', 'Cleanup bugfix builder for a GitHub issue')
    .option('-f, --force', 'Force cleanup even if branch not merged')
    .action(async (options) => {
      const { cleanup } = await import('./commands/cleanup.js');
      try {
        const issue = options.issue ? parseInt(options.issue, 10) : undefined;
        if (!options.project && !issue) {
          logger.error('Must specify either --project (-p) or --issue (-i)');
          process.exit(1);
        }
        if (options.project && issue) {
          logger.error('--project and --issue are mutually exclusive');
          process.exit(1);
        }
        await cleanup({ project: options.project, issue, force: options.force });
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

  // Tower command - cross-project dashboard
  const towerCmd = program
    .command('tower')
    .description('Cross-project dashboard showing all agent-farm instances');

  towerCmd
    .command('start')
    .description('Start the tower dashboard (daemonizes by default)')
    .option('-p, --port <port>', 'Port to run on (default: 4100)')
    .option('--wait', 'Wait for server to start before returning')
    .action(async (options) => {
      try {
        await towerStart({
          port: options.port ? parseInt(options.port, 10) : undefined,
          wait: options.wait,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  towerCmd
    .command('stop')
    .description('Stop the tower dashboard')
    .option('-p, --port <port>', 'Port to stop (default: 4100)')
    .action(async (options) => {
      try {
        await towerStop({
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  towerCmd
    .command('log')
    .description('View tower logs')
    .option('-f, --follow', 'Follow log output (tail -f)')
    .option('-n, --lines <lines>', 'Number of lines to show (default: 50)')
    .action(async (options) => {
      try {
        await towerLog({
          follow: options.follow,
          lines: options.lines ? parseInt(options.lines, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Connect/disconnect handlers (shared with hidden backward-compat aliases)
  const connectAction = async (options: { reauth?: boolean; service?: string; port?: string }) => {
    try {
      await towerRegister({ reauth: options.reauth, serviceUrl: options.service, port: options.port ? parseInt(options.port, 10) : undefined });
      process.exit(0);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };

  const disconnectAction = async (options: { port?: string }) => {
    try {
      await towerDeregister({ port: options.port ? parseInt(options.port, 10) : undefined });
      process.exit(0);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };

  const connectOptions = (cmd: Command) => cmd
    .option('--reauth', 'Update API key without changing tower name')
    .option('--service <url>', 'CodevOS service URL (default: https://cloud.codevos.ai)')
    .option('-p, --port <port>', 'Tower port to signal after connection (default: 4100)');

  const disconnectOptions = (cmd: Command) => cmd
    .option('-p, --port <port>', 'Tower port to signal after disconnection (default: 4100)');

  connectOptions(
    towerCmd
      .command('connect')
      .description('Connect this tower to Codev Cloud for remote access'),
  ).action(connectAction);

  disconnectOptions(
    towerCmd
      .command('disconnect')
      .description('Disconnect this tower from Codev Cloud'),
  ).action(disconnectAction);

  // Hidden backward-compatible aliases (not shown in --help)
  towerCmd.addCommand(
    connectOptions(new Command('register')).action(connectAction),
    { hidden: true },
  );
  towerCmd.addCommand(
    disconnectOptions(new Command('deregister')).action(disconnectAction),
    { hidden: true },
  );

  towerCmd
    .command('status')
    .description('Show tower daemon and cloud connection status')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (options) => {
      try {
        await towerStatus(options.port ? parseInt(options.port, 10) : undefined);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Parse with provided args
  await program.parseAsync(['node', 'af', ...args]);
}
