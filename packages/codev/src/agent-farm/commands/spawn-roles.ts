/**
 * Role and prompt template utilities for spawn command.
 * Spec 0105: Tower Server Decomposition — Phase 7
 *
 * Handles template rendering, prompt building, and role loading
 * for builder sessions.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { SpawnOptions, Config, ProtocolDefinition } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadRolePrompt } from '../utils/roles.js';
import { stripLeadingZeros } from '../utils/agent-names.js';

// =============================================================================
// Template Rendering
// =============================================================================

/**
 * Context object for rendering builder-prompt.md templates
 */
export interface TemplateContext {
  protocol_name: string;
  mode: 'strict' | 'soft';
  mode_soft: boolean;
  mode_strict: boolean;
  project_id?: string;
  input_description: string;
  spec?: {
    path: string;
    name: string;
  };
  plan?: {
    path: string;
    name: string;
  };
  issue?: {
    number: number;
    title: string;
    body: string;
  };
  task_text?: string;
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: TemplateContext, path: string): unknown {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Simple Handlebars-like template renderer
 * Supports: {{variable}}, {{#if condition}}...{{/if}}, {{object.property}}
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  let result = template;

  // Process {{#if condition}}...{{/if}} blocks
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ifMatch = result.match(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/);
    if (!ifMatch) break;

    const [fullMatch, condition, content] = ifMatch;
    const value = getNestedValue(context, condition);
    result = result.replace(fullMatch, value ? content : '');
  }

  // Process {{variable}} and {{object.property}} substitutions
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const value = getNestedValue(context, path);
    if (value === undefined || value === null) return '';
    return String(value);
  });

  // Clean up any double newlines left from removed sections
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Load builder-prompt.md template for a protocol
 */
function loadBuilderPromptTemplate(config: Config, protocolName: string): string | null {
  const templatePath = resolve(config.codevDir, 'protocols', protocolName, 'builder-prompt.md');
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf-8');
  }
  return null;
}

/**
 * Build a fallback prompt when no template exists
 */
function buildFallbackPrompt(protocolName: string, context: TemplateContext): string {
  const modeInstructions = context.mode === 'strict'
    ? `## Mode: STRICT
Porch orchestrates your work. Run: \`porch next\` to get your next tasks.`
    : `## Mode: SOFT
You follow the protocol yourself. The architect monitors your work and verifies compliance.`;

  let prompt = `# ${protocolName.toUpperCase()} Builder (${context.mode} mode)

You are implementing ${context.input_description}.

${modeInstructions}

## Protocol
Follow the ${protocolName.toUpperCase()} protocol: \`codev/protocols/${protocolName}/protocol.md\`
Read and internalize the protocol before starting any work.
`;

  if (context.spec) {
    prompt += `\n## Spec\nRead the specification at: \`${context.spec.path}\`\n`;
  }

  if (context.plan) {
    prompt += `\n## Plan\nFollow the implementation plan at: \`${context.plan.path}\`\n`;
  }

  if (context.issue) {
    prompt += `\n## Issue #${context.issue.number}
**Title**: ${context.issue.title}

**Description**:
${context.issue.body || '(No description provided)'}
`;
  }

  if (context.task_text) {
    prompt += `\n## Task\n${context.task_text}\n`;
  }

  return prompt;
}

/**
 * Build the prompt using protocol template or fallback to inline prompt
 */
export function buildPromptFromTemplate(
  config: Config,
  protocolName: string,
  context: TemplateContext
): string {
  const template = loadBuilderPromptTemplate(config, protocolName);
  if (template) {
    logger.info(`Using template: protocols/${protocolName}/builder-prompt.md`);
    return renderTemplate(template, context);
  }
  // Fallback: no template found, return a basic prompt
  logger.debug(`No template found for ${protocolName}, using inline prompt`);
  return buildFallbackPrompt(protocolName, context);
}

// =============================================================================
// Resume Context
// =============================================================================

/**
 * Build a resume notice to prepend to the builder prompt.
 * Tells the builder this is a resumed session and to check existing porch state.
 */
export function buildResumeNotice(_projectId: string): string {
  return `## RESUME SESSION

This is a **resumed** builder session. A previous session was working in this worktree.

Start by running \`porch next\` to check your current state and get next tasks.
If porch state exists, continue from where the previous session left off.
If porch reports "not found", run \`porch init\` to re-initialize.
`;
}

// =============================================================================
// Role Loading
// =============================================================================

/**
 * Load a protocol-specific role if it exists
 */
export function loadProtocolRole(config: Config, protocolName: string): { content: string; source: string } | null {
  const protocolRolePath = resolve(config.codevDir, 'protocols', protocolName, 'role.md');
  if (existsSync(protocolRolePath)) {
    return { content: readFileSync(protocolRolePath, 'utf-8'), source: 'protocol' };
  }
  // Fall back to builder role
  return loadRolePrompt(config, 'builder');
}

// =============================================================================
// Protocol Resolution
// =============================================================================

/**
 * Find a spec file by project ID.
 * Handles legacy zero-padded IDs: `af spawn 76` matches `0076-feature.md`.
 * Strips leading zeros from both the input ID and spec file prefixes for comparison.
 */
export async function findSpecFile(codevDir: string, projectId: string): Promise<string | null> {
  const specsDir = resolve(codevDir, 'specs');

  if (!existsSync(specsDir)) {
    return null;
  }

  const files = await readdir(specsDir);
  const strippedId = stripLeadingZeros(projectId);

  // Try exact match first (e.g., projectId="0076" matches "0076-feature.md")
  for (const file of files) {
    if (file.startsWith(projectId + '-') && file.endsWith('.md')) {
      return resolve(specsDir, file);
    }
  }

  // Try zero-stripped match (e.g., projectId="76" matches "0076-feature.md")
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePrefix = file.split('-')[0];
    if (stripLeadingZeros(filePrefix) === strippedId) {
      return resolve(specsDir, file);
    }
  }

  return null;
}

/**
 * Validate that a protocol exists
 */
export function validateProtocol(config: Config, protocolName: string): void {
  const protocolDir = resolve(config.codevDir, 'protocols', protocolName);
  const protocolFile = resolve(protocolDir, 'protocol.md');

  if (!existsSync(protocolDir)) {
    const protocolsDir = resolve(config.codevDir, 'protocols');
    let available = '';
    if (existsSync(protocolsDir)) {
      const dirs = readdirSync(protocolsDir, { withFileTypes: true })
        .filter((d: Dirent) => d.isDirectory())
        .map((d: Dirent) => d.name);
      if (dirs.length > 0) {
        available = `\n\nAvailable protocols: ${dirs.join(', ')}`;
      }
    }
    fatal(`Protocol not found: ${protocolName}${available}`);
  }

  if (!existsSync(protocolFile)) {
    fatal(`Protocol ${protocolName} exists but has no protocol.md file`);
  }
}

/**
 * Load and parse a protocol.json file
 */
export function loadProtocol(config: Config, protocolName: string): ProtocolDefinition | null {
  const protocolJsonPath = resolve(config.codevDir, 'protocols', protocolName, 'protocol.json');
  if (!existsSync(protocolJsonPath)) {
    return null;
  }
  try {
    const content = readFileSync(protocolJsonPath, 'utf-8');
    return JSON.parse(content) as ProtocolDefinition;
  } catch {
    logger.warn(`Warning: Failed to parse ${protocolJsonPath}`);
    return null;
  }
}

/**
 * Resolve the builder mode (strict vs soft)
 * Precedence: explicit flags > protocol defaults > input type defaults
 */
export function resolveMode(
  options: SpawnOptions,
  protocol: ProtocolDefinition | null,
): 'strict' | 'soft' {
  if (options.strict && options.soft) {
    fatal('--strict and --soft are mutually exclusive');
  }
  if (options.strict) return 'strict';
  if (options.soft) return 'soft';

  if (protocol?.defaults?.mode) {
    return protocol.defaults.mode;
  }

  // Issue-based spawns with non-bugfix protocol default to strict
  if (options.issueNumber && options.protocol !== 'bugfix') return 'strict';
  return 'soft';
}
