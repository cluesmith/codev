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
import { getTowerClient, DEFAULT_TOWER_PORT } from './lib/tower-client.js';
import { version } from '../version.js';

/**
 * Show tower daemon status and cloud connection info.
 */
async function towerStatus(port?: number): Promise<void> {
  const towerPort = port || DEFAULT_TOWER_PORT;
  const client = getTowerClient(towerPort);

  logger.header('Tower Status');

  const status = await client.getStatus();
  if (status) {
    logger.kv('Daemon', `running on port ${towerPort}`);
    if (status.instances) {
      const running = status.instances.filter((i) => i.running);
      const totalTerminals = status.instances.reduce((sum, i) => sum + (i.terminals?.length || 0), 0);
      logger.kv('Workspaces', `${running.length} active / ${status.instances.length} total`);
      logger.kv('Terminals', `${totalTerminals}`);
    }
  } else {
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

  // Architect command - start Claude session with architect role in current terminal
  program
    .command('architect [args...]')
    .description('Start an architect Claude session in the current terminal')
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

  // Rename command (Spec 468)
  program
    .command('rename <name>')
    .description('Rename the current shell session')
    .action(async (name) => {
      const { rename } = await import('./commands/rename.js');
      try {
        await rename({ name });
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
    .option('-t, --task <id>', 'Cleanup task builder (e.g., task-bEPd)')
    .option('-f, --force', 'Force cleanup even if branch not merged')
    .action(async (options) => {
      const { cleanup } = await import('./commands/cleanup.js');
      try {
        const issue = options.issue ? parseInt(options.issue, 10) : undefined;
        const specifiedCount = [options.project, issue, options.task].filter(Boolean).length;
        if (specifiedCount === 0) {
          logger.error('Must specify one of --project (-p), --issue (-i), or --task (-t)');
          process.exit(1);
        }
        if (specifiedCount > 1) {
          logger.error('--project, --issue, and --task are mutually exclusive');
          process.exit(1);
        }
        await cleanup({ project: options.project, issue, task: options.task, force: options.force });
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

  // Bench command - consultation benchmarking
  program
    .command('bench')
    .description('Run consultation benchmarks across engines')
    .option('-i, --iterations <n>', 'Number of benchmark iterations (default: 1)', '1')
    .option('-s, --sequential', 'Run engines sequentially instead of in parallel')
    .option('--prompt <text>', 'Custom consultation prompt')
    .option('--timeout <seconds>', 'Per-engine timeout in seconds (default: 300)')
    .action(async (options) => {
      const { bench, DEFAULT_PROMPT, DEFAULT_TIMEOUT } = await import('./commands/bench.js');
      try {
        const iterations = parseInt(options.iterations, 10);
        const timeout = options.timeout ? parseInt(options.timeout, 10) : DEFAULT_TIMEOUT;
        if (isNaN(iterations) || iterations < 1) {
          logger.error('--iterations must be a positive integer');
          process.exit(1);
        }
        if (isNaN(timeout) || timeout < 1) {
          logger.error('--timeout must be a positive integer');
          process.exit(1);
        }
        await bench({
          iterations,
          sequential: !!options.sequential,
          prompt: options.prompt || DEFAULT_PROMPT,
          timeout,
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

  // Cron commands (Spec 399)
  const cronCmd = program
    .command('cron')
    .description('Scheduled workspace tasks');

  cronCmd
    .command('list')
    .description('List configured cron tasks')
    .option('--all', 'Show tasks across all workspaces')
    .option('-w, --workspace <path>', 'Filter by workspace path')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (options) => {
      const { cronList } = await import('./commands/cron.js');
      try {
        await cronList({
          all: options.all,
          workspace: options.workspace,
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  cronCmd
    .command('status <name>')
    .description('Show status and last run info for a task')
    .option('-w, --workspace <path>', 'Workspace path (required if task name is ambiguous)')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (name, options) => {
      const { cronStatus } = await import('./commands/cron.js');
      try {
        await cronStatus(name, {
          workspace: options.workspace,
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  cronCmd
    .command('run <name>')
    .description('Trigger immediate execution of a task')
    .option('-w, --workspace <path>', 'Workspace path (required if task name is ambiguous)')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (name, options) => {
      const { cronRun } = await import('./commands/cron.js');
      try {
        await cronRun(name, {
          workspace: options.workspace,
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  cronCmd
    .command('enable <name>')
    .description('Enable a disabled task')
    .option('-w, --workspace <path>', 'Workspace path (required if task name is ambiguous)')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (name, options) => {
      const { cronEnable } = await import('./commands/cron.js');
      try {
        await cronEnable(name, {
          workspace: options.workspace,
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  cronCmd
    .command('disable <name>')
    .description('Disable a task without deleting')
    .option('-w, --workspace <path>', 'Workspace path (required if task name is ambiguous)')
    .option('-p, --port <port>', 'Tower port (default: 4100)')
    .action(async (name, options) => {
      const { cronDisable } = await import('./commands/cron.js');
      try {
        await cronDisable(name, {
          workspace: options.workspace,
          port: options.port ? parseInt(options.port, 10) : undefined,
        });
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
