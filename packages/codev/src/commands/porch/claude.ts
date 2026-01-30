/**
 * Claude Worker for Porch (Agent SDK)
 *
 * Invokes Claude programmatically via the Anthropic Agent SDK.
 * Replaces the old `claude --print` subprocess approach.
 *
 * The Worker has full tool access (Read, Edit, Bash, Glob, Grep)
 * and runs inside porch's process — no subprocess, no nested CLI.
 */

import * as fs from 'node:fs';

export interface BuildResult {
  /** Whether the build completed successfully */
  success: boolean;
  /** Claude's output text */
  output: string;
  /** Total cost in USD (if available) */
  cost?: number;
  /** Duration in milliseconds (if available) */
  duration?: number;
}

/**
 * Run a build phase using the Agent SDK.
 *
 * Porch calls this for each BUILD step. The Worker (Claude via Agent SDK)
 * receives a prompt, does work with full tools, and returns a result.
 *
 * Output is streamed to `outputPath` for debugging/monitoring.
 */
export async function buildWithSDK(
  prompt: string,
  outputPath: string,
  cwd: string
): Promise<BuildResult> {
  // Save prompt to file for reference
  const promptFile = outputPath.replace(/\.txt$/, '-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  // Create output file
  fs.writeFileSync(outputPath, '');

  // Dynamically import Agent SDK (it's ESM)
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  let output = '';
  let cost: number | undefined;
  let duration: number | undefined;
  let success = false;

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        cwd,
        maxTurns: 200,
      },
    })) {
      // Stream assistant messages to output file
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            output += block.text + '\n';
            fs.appendFileSync(outputPath, block.text + '\n');
          }
        }
      }

      // Capture result
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          success = true;
          if (message.result) {
            output += message.result;
            fs.appendFileSync(outputPath, message.result);
          }
          cost = message.total_cost_usd;
          duration = message.duration_ms;
        } else {
          // Error result
          success = false;
          const errorMsg = `\n[Agent SDK error: ${message.subtype}]\n`;
          output += errorMsg;
          fs.appendFileSync(outputPath, errorMsg);
          duration = message.duration_ms;
        }
      }
    }
  } catch (err) {
    const errorMsg = `\n[Agent SDK exception: ${(err as Error).message}]\n`;
    output += errorMsg;
    fs.appendFileSync(outputPath, errorMsg);
    success = false;
  }

  return { success, output, cost, duration };
}
