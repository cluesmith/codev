/**
 * generate-image - AI-powered image generation using Google's Gemini model (Nano Banana Pro)
 *
 * Uses the @google/genai SDK with GEMINI_API_KEY from environment. Atlas Cloud
 * serves the same model over a submit-then-poll REST API and is available as an
 * opt-in provider with ATLASCLOUD_API_KEY.
 */

import { GoogleGenAI } from '@google/genai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';

// The model to use for image generation
const MODEL = 'gemini-3-pro-image-preview';

// Resolution options
const RESOLUTIONS = ['1K', '2K', '4K'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

// Valid aspect ratios
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3'] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

// Providers serving the same model
const PROVIDERS = ['gemini', 'atlas'] as const;
type Provider = (typeof PROVIDERS)[number];

// Atlas Cloud serves the same Nano Banana Pro model over its own async REST API
const ATLAS_BASE_URL = 'https://api.atlascloud.ai/api/v1/model';
const ATLAS_MODEL = 'google/nano-banana-pro/text-to-image';
const ATLAS_POLL_INTERVAL_MS = 5000;
const ATLAS_TIMEOUT_MS = 300_000;
// Per-request bounds. ATLAS_TIMEOUT_MS caps the poll loop as a whole, but it is
// only checked between requests, so each fetch carries its own deadline.
const ATLAS_REQUEST_TIMEOUT_MS = 30_000;
const ATLAS_DOWNLOAD_TIMEOUT_MS = 120_000;
// The only status Atlas documents for a prediction that is still running
// (https://www.atlascloud.ai/docs/en/predictions lists exactly processing,
// completed and failed). Anything else is unrecognized and fails, named.
const ATLAS_IN_PROGRESS_STATUSES = new Set(['processing']);
// api.atlascloud.ai rejects some clients' default User-Agent with 403 (error
// code 1010), so every request sends an explicit one.
const ATLAS_USER_AGENT = 'codev-generate-image/1';

export interface GenerateImageOptions {
  output?: string;
  resolution?: string;
  aspect?: string;
  ref?: string[];
  provider?: string;
}

/**
 * Get the Google GenAI client using API key from environment
 */
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red('Error:') +
        ' GEMINI_API_KEY or GOOGLE_API_KEY environment variable not set.\n' +
        'Get an API key at https://aistudio.google.com/apikey'
    );
    process.exit(1);
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Read prompt from string or .txt file path
 */
function readPrompt(promptOrPath: string): string {
  if (promptOrPath.endsWith('.txt')) {
    const resolved = resolve(promptOrPath);
    if (existsSync(resolved)) {
      return readFileSync(resolved, 'utf-8').trim();
    }
  }
  return promptOrPath;
}

/**
 * Check that the downloaded bytes really are an image, and name the file after
 * the container they turned out to be.
 *
 * Atlas serves whatever container the model produced (JPEG for Nano Banana
 * Pro), so writing those bytes into the default `output.png` would mislabel
 * the file. Bytes that are not a recognised image are not written at all: a
 * 200 response carrying an HTML error body must never land in output.png
 * under a green "Image saved". Exits rather than returning on that path.
 */
function targetPathForImageBytes(output: string, bytes: Buffer): string {
  const detected =
    bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
      ? 'jpg'
      : bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        ? 'png'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          ? 'webp'
          : null;
  if (!detected) {
    console.error(
      chalk.red('Error:') +
        ` Atlas returned ${bytes.length} bytes that are not a JPEG, PNG or WebP image` +
        ` (starts with ${bytes.subarray(0, 8).toString('hex') || '<empty>'}).` +
        ' Nothing was written.'
    );
    process.exit(1);
  }
  const current = output.toLowerCase().split('.').pop();
  if (current === detected || (detected === 'jpg' && current === 'jpeg')) return output;
  const renamed = output.replace(/\.[^./\\]+$/, '') + '.' + detected;
  console.log(chalk.yellow('Note:') + ` provider returned ${detected.toUpperCase()}; saving as ${renamed}`);
  return renamed;
}

/**
 * One Atlas exchange - connect, stream and parse - under a single deadline.
 *
 * ATLAS_TIMEOUT_MS bounds the poll loop as a whole, but it is only checked
 * between requests: without a signal, a single stalled connection hangs the
 * command forever. The signal also stays armed while the body streams, so the
 * body read belongs inside the guard too - otherwise a poll that answers 200
 * with an HTML error page, or a download aborted mid-stream, escapes as a raw
 * SyntaxError or TimeoutError stack instead of a clear message.
 */
async function atlasRequest<T>(
  url: string,
  what: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
  init: RequestInit = {}
): Promise<T> {
  // Resolved inside the try, acted on outside it, so that reporting a failure
  // never lands in our own catch.
  let outcome: { ok: true; body: T } | { ok: false; detail: string };
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    outcome = response.ok
      ? { ok: true, body: await read(response) }
      : { ok: false, detail: ` (${response.status}): ${await response.text()}` };
  } catch (error) {
    outcome = {
      ok: false,
      detail:
        error instanceof Error && error.name === 'TimeoutError'
          ? `: no response within ${timeoutMs}ms`
          : `: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!outcome.ok) {
    console.error(chalk.red('Error:') + ` Atlas ${what} failed${outcome.detail}`.trimEnd());
    process.exit(1);
  }
  return outcome.body;
}

/**
 * Generate through Atlas Cloud: submit a job, poll the prediction, download.
 *
 * The cadence and the overall budget are parameters rather than constants so
 * tests can drive the loop without sleeping for real. Nothing but tests passes
 * them; the CLI uses the defaults.
 */
export async function generateViaAtlas(
  promptText: string,
  output: string,
  aspect: AspectRatio,
  resolution: Resolution,
  refs: string[],
  options: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? ATLAS_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? ATLAS_TIMEOUT_MS;

  // Argument problems are reported before credential problems, so that
  // `--provider atlas --ref x` names the unsupported flag rather than a
  // missing key the user would not have needed anyway.
  if (refs.length > 0) {
    console.error(
      chalk.red('Error:') +
        ' --ref is not supported with --provider atlas (this path is text-to-image only).\n' +
        'Use --provider gemini for reference images.'
    );
    process.exit(1);
  }
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red('Error:') +
        ' ATLASCLOUD_API_KEY environment variable not set.\n' +
        'Get an API key at https://www.atlascloud.ai/console'
    );
    process.exit(1);
  }
  // Measured against the endpoint: aspect_ratio is honoured (1:1 -> 1024x1024,
  // 16:9 -> 1376x768), while 1K/2K/4K has no equivalent field here.
  if (resolution !== '1K') {
    console.log(
      chalk.yellow('Note:') +
        ` --resolution ${resolution} is not exposed by this provider; the model's default resolution is returned.`
    );
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': ATLAS_USER_AGENT,
  };

  const submitted = (await atlasRequest(
    `${ATLAS_BASE_URL}/generateImage`,
    'submit',
    ATLAS_REQUEST_TIMEOUT_MS,
    (response) => response.json() as Promise<unknown>,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: ATLAS_MODEL, prompt: promptText, aspect_ratio: aspect }),
    }
  )) as { data?: { id?: unknown } } | null;
  const predictionId = submitted?.data?.id;
  if (typeof predictionId !== 'string' || predictionId === '') {
    console.error(chalk.red('Error:') + ' Atlas did not return a prediction id');
    process.exit(1);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((done) => setTimeout(done, pollIntervalMs));
    // Checked after the sleep, not before it: a pre-sleep check can pass on a
    // budget that expires during the sleep, and then spend a whole further
    // request on it.
    if (Date.now() >= deadline) {
      console.error(
        chalk.red('Error:') + ` Atlas prediction ${predictionId} timed out after ${timeoutMs}ms`
      );
      process.exit(1);
    }
    const polled = (await atlasRequest(
      `${ATLAS_BASE_URL}/prediction/${encodeURIComponent(predictionId)}`,
      'poll',
      ATLAS_REQUEST_TIMEOUT_MS,
      (response) => response.json() as Promise<unknown>,
      { headers }
    )) as { data?: { status?: unknown; outputs?: unknown[]; error?: unknown } } | null;
    const status = polled?.data?.status;
    if (status === 'completed') {
      const url = polled?.data?.outputs?.[0];
      if (typeof url !== 'string' || url === '') {
        console.error(chalk.red('Error:') + ' Atlas completed without an image URL');
        process.exit(1);
      }
      // No Atlas headers here: the CDN is a different origin and must never
      // see the API key.
      const bytes = Buffer.from(
        await atlasRequest(url, 'image download', ATLAS_DOWNLOAD_TIMEOUT_MS, (response) =>
          response.arrayBuffer()
        )
      );
      const target = targetPathForImageBytes(output, bytes);
      writeFileSync(target, bytes);
      console.log(chalk.green('Image saved to') + ` ${target}`);
      return;
    }
    if (status === 'failed') {
      const detail = polled?.data?.error;
      console.error(
        chalk.red('Error:') +
          ` Atlas generation failed: ${typeof detail === 'string' && detail !== '' ? detail : 'unknown'}`
      );
      process.exit(1);
    }
    if (typeof status !== 'string' || !ATLAS_IN_PROGRESS_STATUSES.has(status)) {
      // Polling on past a status we don't understand burns the full timeout and
      // then reports it as one, which is a lie about what happened.
      console.error(
        chalk.red('Error:') +
          ` Atlas prediction ${predictionId} reported an unrecognized status: ` +
          (status === undefined ? '(none)' : String(status))
      );
      process.exit(1);
    }
  }
}

/**
 * Main generate-image function
 */
// Maximum reference images supported by Nano Banana Pro
const MAX_REFERENCE_IMAGES = 14;

export async function generateImage(
  prompt: string,
  options: GenerateImageOptions
): Promise<void> {
  const output = options.output || 'output.png';
  const resolution = (options.resolution || '1K') as Resolution;
  const aspect = (options.aspect || '1:1') as AspectRatio;
  const refs = options.ref || [];
  const provider = (options.provider || 'gemini') as Provider;

  // Validate provider
  if (!PROVIDERS.includes(provider)) {
    console.error(
      chalk.red('Error:') + ` Invalid provider '${provider}'. Use: ${PROVIDERS.join(', ')}`
    );
    process.exit(1);
  }

  // Validate resolution
  if (!RESOLUTIONS.includes(resolution)) {
    console.error(
      chalk.red('Error:') +
        ` Invalid resolution '${resolution}'. Use: ${RESOLUTIONS.join(', ')}`
    );
    process.exit(1);
  }

  // Validate aspect ratio
  if (!ASPECT_RATIOS.includes(aspect)) {
    console.error(
      chalk.red('Error:') +
        ` Invalid aspect ratio '${aspect}'. Use: ${ASPECT_RATIOS.join(', ')}`
    );
    process.exit(1);
  }

  // Validate reference image count
  if (refs.length > MAX_REFERENCE_IMAGES) {
    console.error(
      chalk.red('Error:') +
        ` Too many reference images (${refs.length}). Maximum is ${MAX_REFERENCE_IMAGES}.`
    );
    process.exit(1);
  }

  // Validate reference images exist
  const referenceImagePaths: string[] = [];
  for (const ref of refs) {
    const refPath = resolve(ref);
    if (!existsSync(refPath)) {
      console.error(chalk.red('Error:') + ` Reference image not found: ${ref}`);
      process.exit(1);
    }
    referenceImagePaths.push(refPath);
  }

  // Read prompt
  const promptText = readPrompt(prompt);

  if (provider === 'atlas') {
    console.log(chalk.blue('Generating image with') + ` ${ATLAS_MODEL} (Atlas Cloud)...`);
    await generateViaAtlas(promptText, output, aspect, resolution, refs);
    return;
  }

  console.log(chalk.blue('Generating image with') + ` ${MODEL}...`);

  // Create client
  const client = getClient();

  // Build contents - either just prompt or prompt with reference images
  let contents: string | Array<{ inlineData: { mimeType: string; data: string } } | string>;

  if (referenceImagePaths.length > 0) {
    const imageParts: Array<{ inlineData: { mimeType: string; data: string } } | string> = [];

    for (const imagePath of referenceImagePaths) {
      const imageData = readFileSync(imagePath);
      const base64Data = imageData.toString('base64');
      // Determine mime type from extension
      const ext = imagePath.toLowerCase().split('.').pop();
      const mimeType =
        ext === 'png'
          ? 'image/png'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/jpeg';

      imageParts.push({
        inlineData: {
          mimeType,
          data: base64Data,
        },
      });
    }

    // Add prompt after all images
    imageParts.push(promptText);
    contents = imageParts;

    console.log(chalk.blue('Using') + ` ${referenceImagePaths.length} reference image(s)`);
  } else {
    contents = promptText;
  }

  // Build image config
  const imageConfig: { aspectRatio: string; imageSize?: string } = {
    aspectRatio: aspect,
  };
  if (resolution !== '1K') {
    imageConfig.imageSize = resolution;
  }

  const response = await client.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseModalities: ['IMAGE'],
      imageConfig,
    },
  });

  // Find and save the image from response
  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    console.error(chalk.red('Error:') + ' No response candidates');
    process.exit(1);
  }

  const parts = candidates[0]?.content?.parts;
  if (!parts) {
    console.error(chalk.red('Error:') + ' No parts in response');
    process.exit(1);
  }

  for (const part of parts) {
    if (part.text) {
      console.log(chalk.blue('Model response:') + ` ${part.text}`);
    } else if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      writeFileSync(output, buffer);
      console.log(chalk.green('Image saved to') + ` ${output}`);
      return;
    }
  }

  console.error(chalk.red('Error:') + ' No image in response');
  process.exit(1);
}
