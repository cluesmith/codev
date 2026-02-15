#!/usr/bin/env node

/**
 * Codev CLI - Unified entry point for codev framework
 */

import { Command } from 'commander';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { adopt } from './commands/adopt.js';
import { update } from './commands/update.js';
import { consult } from './commands/consult/index.js';
import { handleStats } from './commands/consult/stats.js';
import { cli as porchCli } from './commands/porch/index.js';
import { importCommand } from './commands/import.js';
import { generateImage } from './commands/generate-image.js';
import { runAgentFarm } from './agent-farm/cli.js';
import { version } from './version.js';

const program = new Command();

program
  .name('codev')
  .description('Codev CLI - AI-assisted software development framework')
  .version(version);

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

// Consult command
program
  .command('consult')
  .description('AI consultation with external models')
  .argument('<subcommand>', 'Subcommand: pr, spec, plan, or general')
  .argument('[args...]', 'Arguments for the subcommand')
  .option('-m, --model <model>', 'Model to use (gemini, codex, claude, or aliases: pro, gpt, opus)')
  .option('-n, --dry-run', 'Show what would execute without running')
  .option('-t, --type <type>', 'Review type: spec-review, plan-review, impl-review, pr-ready, integration-review')
  .option('-r, --role <role>', 'Custom role from codev/roles/<name>.md (e.g., gtm-specialist, security-reviewer)')
  .option('--output <path>', 'Write consultation output to file (used by porch for review file collection)')
  .option('--plan-phase <phase>', 'Scope impl review to a specific plan phase (used by porch for phased protocols)')
  .option('--context <path>', 'Context file with previous iteration feedback (used by porch for stateful reviews)')
  .option('--protocol <name>', 'Protocol context: spir, tick, bugfix (used by porch)')
  .option('--project-id <id>', 'Porch project ID (used by porch)')
  .option('--days <n>', 'Stats: limit to last N days (default: 30)')
  .option('--project <id>', 'Stats: filter by project ID')
  .option('--last <n>', 'Stats: show last N individual invocations')
  .option('--json', 'Stats: output as JSON')
  .allowUnknownOption(true)
  .action(async (subcommand, args, options) => {
    try {
      // Stats subcommand doesn't require -m flag
      if (subcommand === 'stats') {
        await handleStats(args, options);
        return;
      }

      // All other subcommands require -m
      if (!options.model) {
        console.error('Missing required option: -m, --model');
        process.exit(1);
      }

      await consult({
        model: options.model,
        subcommand,
        args,
        dryRun: options.dryRun,
        reviewType: options.type,
        role: options.role,
        output: options.output,
        planPhase: options.planPhase,
        context: options.context,
        protocol: options.protocol,
        projectId: options.projectId,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Porch command (Protocol Orchestrator)
program
  .command('porch')
  .description('Protocol orchestrator - run development protocols')
  .argument('<subcommand>', 'Subcommand: status, check, done, gate, approve, init')
  .argument('[args...]', 'Arguments for the subcommand')
  .allowUnknownOption()
  .action(async (subcommand, args) => {
    try {
      await porchCli([subcommand, ...args]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Import command
program
  .command('import <source>')
  .description('AI-assisted protocol import from other codev projects')
  .option('-n, --dry-run', 'Show what would be imported without running Claude')
  .action(async (source, options) => {
    try {
      await importCommand(source, { dryRun: options.dryRun });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Generate-image command
program
  .command('generate-image')
  .description('Generate images using Gemini (Nano Banana Pro)')
  .argument('<prompt>', 'Text prompt or path to .txt file')
  .option('-o, --output <path>', 'Output file path', 'output.png')
  .option('-r, --resolution <res>', 'Resolution: 1K, 2K, or 4K', '1K')
  .option('-a, --aspect <ratio>', 'Aspect ratio: 1:1, 16:9, 9:16, 3:4, 4:3, 3:2, 2:3', '1:1')
  .option('--ref <path...>', 'Reference image(s) for image-to-image generation (up to 14)')
  .action(async (prompt, options) => {
    try {
      await generateImage(prompt, {
        output: options.output,
        resolution: options.resolution,
        aspect: options.aspect,
        ref: options.ref,
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
