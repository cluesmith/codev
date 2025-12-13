/**
 * generate-image - AI-powered image generation using Google's Gemini/Imagen models
 *
 * Uses the @google/genai SDK with GEMINI_API_KEY from environment.
 */

import { GoogleGenAI } from '@google/genai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';

// Resolution options
const RESOLUTIONS = ['1K', '2K', '4K'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

// Valid aspect ratios
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3'] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

// Model aliases and their full names
const MODELS: Record<string, string> = {
  'gemini-3-pro-image': 'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image': 'gemini-2.5-flash-image',
  'imagen-4': 'imagen-4.0-generate-001',
};

export interface GenerateImageOptions {
  output?: string;
  resolution?: string;
  aspect?: string;
  model?: string;
  ref?: string;
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
 * Generate image using Imagen model
 */
async function generateWithImagen(
  client: GoogleGenAI,
  prompt: string,
  model: string,
  aspectRatio: string,
  outputPath: string
): Promise<void> {
  const response = await client.models.generateImages({
    model,
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio,
    },
  });

  if (!response.generatedImages || response.generatedImages.length === 0) {
    console.error(chalk.red('Error:') + ' No images generated');
    process.exit(1);
  }

  const generatedImage = response.generatedImages[0];
  if (generatedImage?.raiFilteredReason) {
    console.error(
      chalk.yellow('Filter reason:') + ` ${generatedImage.raiFilteredReason}`
    );
  }

  const imageBytes = generatedImage?.image?.imageBytes;
  if (!imageBytes) {
    console.error(chalk.red('Error:') + ' No image data in response');
    process.exit(1);
  }

  // Write base64-encoded image to file
  const buffer = Buffer.from(imageBytes, 'base64');
  writeFileSync(outputPath, buffer);
  console.log(chalk.green('Image saved to') + ` ${outputPath}`);
}

/**
 * Generate image using Gemini model with native image output
 */
async function generateWithGemini(
  client: GoogleGenAI,
  prompt: string,
  model: string,
  aspectRatio: string,
  resolution: string,
  outputPath: string,
  referenceImagePath?: string
): Promise<void> {
  // Build contents - either just prompt or prompt with reference image
  let contents: string | Array<{ inlineData: { mimeType: string; data: string } } | string>;

  if (referenceImagePath) {
    const imageData = readFileSync(referenceImagePath);
    const base64Data = imageData.toString('base64');
    // Determine mime type from extension
    const ext = referenceImagePath.toLowerCase().split('.').pop();
    const mimeType =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg';

    contents = [
      {
        inlineData: {
          mimeType,
          data: base64Data,
        },
      },
      prompt,
    ];
  } else {
    contents = prompt;
  }

  // Build image config
  const imageConfig: { aspectRatio: string; imageSize?: string } = {
    aspectRatio,
  };
  if (resolution !== '1K') {
    imageConfig.imageSize = resolution;
  }

  const response = await client.models.generateContent({
    model,
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
      writeFileSync(outputPath, buffer);
      console.log(chalk.green('Image saved to') + ` ${outputPath}`);
      return;
    }
  }

  console.error(chalk.red('Error:') + ' No image in response');
  process.exit(1);
}

/**
 * Main generate-image function
 */
export async function generateImage(
  prompt: string,
  options: GenerateImageOptions
): Promise<void> {
  const output = options.output || 'output.png';
  const resolution = (options.resolution || '1K') as Resolution;
  const aspect = (options.aspect || '1:1') as AspectRatio;
  const modelArg = options.model || 'gemini-2.5-flash-image';
  const ref = options.ref;

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

  // Resolve model name
  const resolvedModel = MODELS[modelArg] || modelArg;

  // Validate reference image
  if (ref) {
    const refPath = resolve(ref);
    if (!existsSync(refPath)) {
      console.error(chalk.red('Error:') + ` Reference image not found: ${ref}`);
      process.exit(1);
    }

    // Check for incompatible options
    if (resolvedModel.toLowerCase().includes('imagen')) {
      console.error(
        chalk.red('Error:') + ' Reference images not supported with Imagen models'
      );
      process.exit(1);
    }
  }

  // Warn about resolution limitations
  if (resolution !== '1K' && resolvedModel.toLowerCase().includes('flash')) {
    console.error(
      chalk.yellow('Warning:') +
        ` Resolution ${resolution} may not be supported by ${modelArg}. ` +
        'Use gemini-3-pro-image for high resolution.'
    );
  }

  // Read prompt
  const promptText = readPrompt(prompt);
  console.log(chalk.blue('Generating image with') + ` ${resolvedModel}...`);

  // Create client
  const client = getClient();

  // Generate based on model type
  if (resolvedModel.toLowerCase().includes('imagen')) {
    await generateWithImagen(client, promptText, resolvedModel, aspect, output);
  } else {
    await generateWithGemini(
      client,
      promptText,
      resolvedModel,
      aspect,
      resolution,
      output,
      ref ? resolve(ref) : undefined
    );
  }
}
