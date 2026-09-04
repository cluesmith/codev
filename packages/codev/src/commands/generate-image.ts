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
 * Name a downloaded image after its actual bytes.
 *
 * Atlas serves whatever container the model produced (JPEG for Nano Banana
 * Pro), so writing those bytes into the default `output.png` would mislabel
 * the file.
 */
function withDetectedExtension(output: string, bytes: Buffer): string {
  const detected =
    bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
      ? 'jpg'
      : bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        ? 'png'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          ? 'webp'
          : null;
  if (!detected) return output;
  const current = output.toLowerCase().split('.').pop();
  if (current === detected || (detected === 'jpg' && current === 'jpeg')) return output;
  const renamed = output.replace(/\.[^./\\]+$/, '') + '.' + detected;
  console.log(chalk.yellow('Note:') + ` provider returned ${detected.toUpperCase()}; saving as ${renamed}`);
  return renamed;
}

/**
 * Generate through Atlas Cloud: submit a job, poll the prediction, download.
 */
async function generateViaAtlas(
  promptText: string,
  output: string,
  aspect: AspectRatio,
  resolution: Resolution,
  refs: string[]
): Promise<void> {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red('Error:') +
        ' ATLASCLOUD_API_KEY environment variable not set.\n' +
        'Get an API key at https://www.atlascloud.ai/console'
    );
    process.exit(1);
  }
  if (refs.length > 0) {
    console.error(
      chalk.red('Error:') +
        ' --ref is not supported with --provider atlas (this path is text-to-image only).\n' +
        'Use --provider gemini for reference images.'
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

  const submitResponse = await fetch(`${ATLAS_BASE_URL}/generateImage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: ATLAS_MODEL, prompt: promptText, aspect_ratio: aspect }),
  });
  if (!submitResponse.ok) {
    console.error(
      chalk.red('Error:') + ` Atlas submit failed (${submitResponse.status}): ${await submitResponse.text()}`
    );
    process.exit(1);
  }
  const submitted = (await submitResponse.json()) as { data?: { id?: string } };
  const predictionId = submitted.data?.id;
  if (!predictionId) {
    console.error(chalk.red('Error:') + ' Atlas did not return a prediction id');
    process.exit(1);
  }

  const deadline = Date.now() + ATLAS_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      console.error(chalk.red('Error:') + ` Atlas prediction ${predictionId} timed out`);
      process.exit(1);
    }
    await new Promise((done) => setTimeout(done, ATLAS_POLL_INTERVAL_MS));
    const pollResponse = await fetch(
      `${ATLAS_BASE_URL}/prediction/${encodeURIComponent(predictionId)}`,
      { headers }
    );
    if (!pollResponse.ok) {
      console.error(
        chalk.red('Error:') + ` Atlas poll failed (${pollResponse.status}): ${await pollResponse.text()}`
      );
      process.exit(1);
    }
    const polled = (await pollResponse.json()) as {
      data?: { status?: string; outputs?: string[]; error?: string };
    };
    const status = polled.data?.status;
    if (status === 'completed') {
      const url = polled.data?.outputs?.[0];
      if (!url) {
        console.error(chalk.red('Error:') + ' Atlas completed without an image URL');
        process.exit(1);
      }
      const download = await fetch(url);
      if (!download.ok) {
        console.error(chalk.red('Error:') + ` Atlas image download failed (${download.status})`);
        process.exit(1);
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      const target = withDetectedExtension(output, bytes);
      writeFileSync(target, bytes);
      console.log(chalk.green('Image saved to') + ` ${target}`);
      return;
    }
    if (status === 'failed') {
      console.error(chalk.red('Error:') + ` Atlas generation failed: ${polled.data?.error ?? 'unknown'}`);
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
