#!/usr/bin/env node

/**
 * Codev CLI - Unified entry point for codev framework
 */

import { Command } from 'commander';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { adopt } from './commands/adopt.js';
import { update } from './commands/update.js';
import { eject } from './commands/eject.js';
import { tower } from './commands/tower.js';
import { consult } from './commands/consult/index.js';
import { runAgentFarm } from './agent-farm/cli.js';

const program = new Command();

program
  .name('codev')
  .description('Codev CLI - AI-assisted software development framework')
  .version('1.0.0');

// Doctor command
program
  .command('doctor')
  .description('Check system dependencies')
  .action(async () => {
    try {
      const exitCode = await doctor();
      process.exit(exitCode);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Init command
program
  .command('init [project-name]')
  .description('Create a new codev project')
  .option('-y, --yes', 'Use defaults without prompting')
  .action(async (projectName, options) => {
    try {
      await init(projectName, { yes: options.yes });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Adopt command
program
  .command('adopt')
  .description('Add codev to an existing project')
  .option('-y, --yes', 'Skip conflict prompts')
  .action(async (options) => {
    try {
      await adopt({ yes: options.yes });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Update command
program
  .command('update')
  .description('Update codev templates and protocols')
  .option('-n, --dry-run', 'Show changes without applying')
  .option('-f, --force', 'Force update, overwrite all files')
  .action(async (options) => {
    try {
      await update({ dryRun: options.dryRun, force: options.force });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Eject command
program
  .command('eject [path]')
  .description('Copy embedded skeleton files locally for customization')
  .option('-l, --list', 'List available files to eject')
  .option('-f, --force', 'Overwrite existing files')
  .action(async (targetPath, options) => {
    try {
      await eject(targetPath, { list: options.list, force: options.force });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Tower command
program
  .command('tower')
  .description('Cross-project dashboard showing all agent-farm instances')
  .option('-p, --port <port>', 'Port to run on (default: 4100)')
  .option('--stop', 'Stop the tower dashboard')
  .action(async (options) => {
    try {
      await tower({
        port: options.port ? parseInt(options.port, 10) : undefined,
        stop: options.stop,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Consult command
program
  .command('consult')
  .description('AI consultation with external models')
  .argument('<subcommand>', 'Subcommand: pr, spec, plan, or general')
  .argument('[args...]', 'Arguments for the subcommand')
  .requiredOption('-m, --model <model>', 'Model to use (gemini, codex, claude, or aliases: pro, gpt, opus)')
  .option('-n, --dry-run', 'Show what would execute without running')
  .option('-t, --type <type>', 'Review type: spec-review, plan-review, impl-review, pr-ready, integration-review')
  .allowUnknownOption(true)
  .action(async (subcommand, args, options) => {
    try {
      await consult({
        model: options.model,
        subcommand,
        args,
        dryRun: options.dryRun,
        reviewType: options.type,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Agent-farm command (delegates to existing agent-farm CLI)
program
  .command('agent-farm', { hidden: false })
  .alias('af')
  .description('Agent farm commands (start, spawn, status, etc.)')
  .allowUnknownOption(true)
  .action(async () => {
    // This is handled specially - delegate to agent-farm
    // The args after 'agent-farm' need to be passed through
  });

/**
 * Run the CLI with given arguments
 * Used by bin shims (af.js, consult.js) to inject commands
 */
export async function run(args: string[]): Promise<void> {
  // Check if this is an agent-farm command
  if (args[0] === 'agent-farm') {
    await runAgentFarm(args.slice(1));
    return;
  }

  // Prepend 'node' and 'codev' to make commander happy
  const fullArgs = ['node', 'codev', ...args];
  await program.parseAsync(fullArgs);
}

// If run directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/codev.js') ||
  process.argv[1]?.endsWith('/codev');

if (isMainModule) {
  // Check for agent-farm subcommand before commander parses
  const args = process.argv.slice(2);
  if (args[0] === 'agent-farm' || args[0] === 'af') {
    runAgentFarm(args.slice(1)).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else {
    program.parseAsync(process.argv).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}
