/**
 * Multi-Agent Consultation
 *
 * Runs parallel 3-way consultations with external AI models (gemini, codex, claude)
 * and collects feedback with APPROVE/REQUEST_CHANGES verdicts.
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type {
  ConsultationConfig,
  ConsultationFeedback,
  ConsultationResult,
  ConsultationVerdict,
} from './types.js';

/**
 * Default consultation timeout (ms)
 */
const DEFAULT_TIMEOUT = 300000; // 5 minutes

/**
 * Run a single consultation with an AI model
 */
async function runConsultation(
  model: string,
  command: string,
  args: string[],
  options: {
    timeout?: number;
    cwd?: string;
  } = {}
): Promise<{ output: string; error?: string; success: boolean }> {
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let stderr = '';
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      if (timedOut) {
        resolve({
          output,
          error: `Consultation timed out after ${timeout}ms`,
          success: false,
        });
      } else {
        resolve({
          output: output + stderr,
          error: code !== 0 ? `Exit code: ${code}` : undefined,
          success: code === 0,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        output: '',
        error: err.message,
        success: false,
      });
    });
  });
}

/**
 * Parse verdict from consultation output
 * Looks for APPROVE or REQUEST_CHANGES markers
 */
export function parseVerdict(output: string): ConsultationVerdict {
  // Look for explicit verdict markers
  if (/verdict:\s*approve/i.test(output) || /\[APPROVE\]/i.test(output)) {
    return 'APPROVE';
  }
  if (/verdict:\s*request_changes/i.test(output) || /\[REQUEST_CHANGES\]/i.test(output)) {
    return 'REQUEST_CHANGES';
  }

  // Look for implicit approval signals
  if (/looks good/i.test(output) && !/but|however|should|could/i.test(output.slice(output.search(/looks good/i), output.search(/looks good/i) + 100))) {
    return 'APPROVE';
  }
  if (/approved?/i.test(output) && !/not approved/i.test(output)) {
    return 'APPROVE';
  }

  // Look for implicit change request signals
  if (/must\s+(be\s+)?fix|should\s+(be\s+)?fix|need(s)?\s+to\s+fix|critical\s+issue|blocking\s+issue/i.test(output)) {
    return 'REQUEST_CHANGES';
  }

  // Default to approve if no clear signal (lenient mode)
  return 'APPROVE';
}

/**
 * Extract summary from consultation output
 * Takes the first paragraph or bullet points
 */
export function extractSummary(output: string, maxLength: number = 500): string {
  // Try to find a summary section
  const summaryMatch = output.match(/##?\s*Summary\s*\n([\s\S]*?)(?=\n##|\n\*\*|$)/i);
  if (summaryMatch) {
    return truncate(summaryMatch[1].trim(), maxLength);
  }

  // Try to find verdict section
  const verdictMatch = output.match(/##?\s*Verdict\s*\n([\s\S]*?)(?=\n##|\n\*\*|$)/i);
  if (verdictMatch) {
    return truncate(verdictMatch[1].trim(), maxLength);
  }

  // Fall back to first paragraph
  const paragraphs = output.split(/\n\n+/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed.length > 50 && !trimmed.startsWith('#') && !trimmed.startsWith('```')) {
      return truncate(trimmed, maxLength);
    }
  }

  return truncate(output.trim(), maxLength);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Build the consult command for a model
 */
function buildConsultCommand(
  model: string,
  subcommand: string,
  identifier: string,
  reviewType?: string
): { command: string; args: string[] } {
  const args = ['--model', model, subcommand, identifier];

  if (reviewType) {
    args.push('--type', reviewType);
  }

  return {
    command: 'consult',
    args,
  };
}

/**
 * Run parallel 3-way consultation
 */
export async function runParallelConsultation(
  config: ConsultationConfig,
  context: {
    subcommand: string;
    identifier: string;
    cwd?: string;
    timeout?: number;
    dryRun?: boolean;
  }
): Promise<ConsultationFeedback[]> {
  const { subcommand, identifier, cwd, timeout = DEFAULT_TIMEOUT, dryRun } = context;
  const { models, type: reviewType, parallel = true } = config;

  if (dryRun) {
    console.log(chalk.yellow(`[consultation] [DRY RUN] Would run ${models.length}-way consultation:`));
    for (const model of models) {
      const { command, args } = buildConsultCommand(model, subcommand, identifier, reviewType);
      console.log(chalk.yellow(`  ${command} ${args.join(' ')}`));
    }
    return models.map(model => ({
      model,
      verdict: 'APPROVE',
      summary: '[DRY RUN] Simulated approval',
    }));
  }

  console.log(chalk.blue(`[consultation] Running ${models.length}-way parallel consultation...`));

  const startTime = Date.now();

  // Build commands for each model
  const consultations = models.map(model => {
    const { command, args } = buildConsultCommand(model, subcommand, identifier, reviewType);
    console.log(chalk.blue(`[consultation] Starting ${model}...`));
    return {
      model,
      promise: runConsultation(model, command, args, { timeout, cwd }),
    };
  });

  // Run in parallel or sequentially based on config
  const results: ConsultationFeedback[] = [];

  if (parallel) {
    // Run all in parallel
    const outputs = await Promise.all(consultations.map(c => c.promise));

    for (let i = 0; i < consultations.length; i++) {
      const { model } = consultations[i];
      const output = outputs[i];

      if (!output.success) {
        console.log(chalk.yellow(`[consultation] ${model} failed: ${output.error}`));
        results.push({
          model,
          verdict: 'APPROVE', // Default to approve on failure (lenient)
          summary: `Consultation failed: ${output.error}`,
        });
      } else {
        const verdict = parseVerdict(output.output);
        const summary = extractSummary(output.output);
        const duration = Date.now() - startTime;

        console.log(chalk.blue(`[consultation] ${model} completed (${duration}ms): ${verdict}`));
        results.push({ model, verdict, summary });
      }
    }
  } else {
    // Run sequentially
    for (const { model, promise } of consultations) {
      const output = await promise;
      const duration = Date.now() - startTime;

      if (!output.success) {
        console.log(chalk.yellow(`[consultation] ${model} failed: ${output.error}`));
        results.push({
          model,
          verdict: 'APPROVE',
          summary: `Consultation failed: ${output.error}`,
        });
      } else {
        const verdict = parseVerdict(output.output);
        const summary = extractSummary(output.output);

        console.log(chalk.blue(`[consultation] ${model} completed (${duration}ms): ${verdict}`));
        results.push({ model, verdict, summary });
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log(chalk.blue(`[consultation] All consultations complete (${totalDuration}ms)`));

  return results;
}

/**
 * Run consultation loop with revision support
 *
 * If any model returns REQUEST_CHANGES, allows revision and re-consultation
 * up to max_rounds times.
 */
export async function runConsultationLoop(
  config: ConsultationConfig,
  context: {
    subcommand: string;
    identifier: string;
    cwd?: string;
    timeout?: number;
    dryRun?: boolean;
    onRevisionNeeded?: (feedback: ConsultationFeedback[]) => Promise<boolean>;
  }
): Promise<ConsultationResult> {
  const maxRounds = config.max_rounds || 3;
  let round = 1;

  while (round <= maxRounds) {
    console.log(chalk.blue(`[consultation] Round ${round}/${maxRounds}`));

    const feedback = await runParallelConsultation(config, context);

    // Check if all approved
    const allApproved = feedback.every(f => f.verdict === 'APPROVE');

    if (allApproved) {
      console.log(chalk.green(`[consultation] All models approved!`));
      return { round, feedback, allApproved: true };
    }

    // Some models requested changes
    const changeRequests = feedback.filter(f => f.verdict === 'REQUEST_CHANGES');
    console.log(chalk.yellow(`[consultation] ${changeRequests.length} model(s) requested changes:`));

    for (const req of changeRequests) {
      console.log(chalk.yellow(`  ${req.model}: ${req.summary}`));
    }

    // Check if we've reached max rounds
    if (round >= maxRounds) {
      console.log(chalk.red(`[consultation] Max rounds (${maxRounds}) reached without full approval`));
      return { round, feedback, allApproved: false };
    }

    // Call revision callback if provided
    if (context.onRevisionNeeded) {
      const shouldContinue = await context.onRevisionNeeded(feedback);
      if (!shouldContinue) {
        console.log(chalk.yellow(`[consultation] Revision declined, stopping consultation loop`));
        return { round, feedback, allApproved: false };
      }
    } else {
      // No revision callback - just report and exit
      console.log(chalk.yellow(`[consultation] Changes requested but no revision handler`));
      return { round, feedback, allApproved: false };
    }

    round++;
  }

  // Should not reach here
  return { round, feedback: [], allApproved: false };
}

/**
 * Format consultation results for display
 */
export function formatConsultationResults(result: ConsultationResult): string {
  const lines: string[] = [
    `Consultation Results (Round ${result.round}):`,
    result.allApproved ? chalk.green('  ✓ All models approved') : chalk.yellow('  ⚠ Not all models approved'),
    '',
  ];

  for (const feedback of result.feedback) {
    const icon = feedback.verdict === 'APPROVE' ? '✓' : '✗';
    const color = feedback.verdict === 'APPROVE' ? chalk.green : chalk.yellow;
    lines.push(color(`  ${icon} ${feedback.model}: ${feedback.verdict}`));
    if (feedback.summary) {
      lines.push(`    ${feedback.summary.slice(0, 100)}...`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if a phase has consultation configured
 */
export function hasConsultation(phaseConfig: { consultation?: ConsultationConfig }): boolean {
  return phaseConfig.consultation !== undefined &&
    phaseConfig.consultation.models !== undefined &&
    phaseConfig.consultation.models.length > 0;
}

/**
 * Get the default consultation config for common review types
 */
export function getDefaultConsultationConfig(type: string): ConsultationConfig {
  const defaultModels = ['gemini', 'codex', 'claude'];

  switch (type) {
    case 'spec-review':
      return {
        on: 'review',
        models: defaultModels,
        type: 'spec-review',
        parallel: true,
        max_rounds: 3,
        next: 'plan',
      };
    case 'plan-review':
      return {
        on: 'review',
        models: defaultModels,
        type: 'plan-review',
        parallel: true,
        max_rounds: 3,
        next: 'implement',
      };
    case 'impl-review':
      return {
        on: 'complete',
        models: defaultModels,
        type: 'impl-review',
        parallel: true,
        max_rounds: 2,
        next: 'defend',
      };
    default:
      return {
        on: 'review',
        models: defaultModels,
        type: type,
        parallel: true,
        max_rounds: 2,
        next: '',
      };
  }
}
