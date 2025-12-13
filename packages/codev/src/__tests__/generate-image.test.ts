/**
 * Tests for generate-image command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Mock modules before importing the module under test
const mockGenerateImages = vi.fn();
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateImages: mockGenerateImages,
        generateContent: mockGenerateContent,
      };
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Import after mocks are set up
import { generateImage, GenerateImageOptions } from '../commands/generate-image.js';

describe('generate-image', () => {
  const originalEnv = process.env;
  const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as () => never);
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('API key validation', () => {
    it('exits with error when no API key is set', async () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      await expect(generateImage('test prompt', {})).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('GEMINI_API_KEY or GOOGLE_API_KEY environment variable not set')
      );
    });

    it('uses GOOGLE_API_KEY as fallback', async () => {
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_API_KEY = 'google-key';

      mockGenerateImages.mockResolvedValue({
        generatedImages: [{ image: { imageBytes: 'dGVzdA==' } }],
      });

      await generateImage('test prompt', { model: 'imagen-4' });
      expect(mockGenerateImages).toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('rejects invalid resolution', async () => {
      await expect(
        generateImage('test prompt', { resolution: '5K' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid resolution '5K'")
      );
    });

    it('rejects invalid aspect ratio', async () => {
      await expect(
        generateImage('test prompt', { aspect: '99:1' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid aspect ratio '99:1'")
      );
    });

    it('rejects non-existent reference image', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(
        generateImage('test prompt', { ref: '/nonexistent/image.jpg' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Reference image not found')
      );
    });

    it('rejects reference images with Imagen model', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(
        generateImage('test prompt', { ref: 'ref.jpg', model: 'imagen-4' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Reference images not supported with Imagen models')
      );
    });
  });

  describe('Imagen model generation', () => {
    it('generates image successfully', async () => {
      const mockImageBytes = Buffer.from('test image data').toString('base64');
      mockGenerateImages.mockResolvedValue({
        generatedImages: [{ image: { imageBytes: mockImageBytes } }],
      });

      await generateImage('A test prompt', { model: 'imagen-4', output: 'test.png' });

      expect(mockGenerateImages).toHaveBeenCalledWith({
        model: 'imagen-4.0-generate-001',
        prompt: 'A test prompt',
        config: {
          numberOfImages: 1,
          aspectRatio: '1:1',
        },
      });
      expect(writeFileSync).toHaveBeenCalledWith('test.png', expect.any(Buffer));
    });

    it('handles empty response', async () => {
      mockGenerateImages.mockResolvedValue({
        generatedImages: [],
      });

      await expect(
        generateImage('test', { model: 'imagen-4' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('No images generated')
      );
    });

    it('logs RAI filter reason when present', async () => {
      mockGenerateImages.mockResolvedValue({
        generatedImages: [{
          raiFilteredReason: 'Content policy violation',
          image: { imageBytes: 'dGVzdA==' },
        }],
      });

      await generateImage('test', { model: 'imagen-4' });
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Content policy violation')
      );
    });
  });

  describe('Gemini model generation', () => {
    it('generates image successfully', async () => {
      const mockImageData = Buffer.from('gemini image').toString('base64');
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                data: mockImageData,
                mimeType: 'image/png',
              },
            }],
          },
        }],
      });

      await generateImage('A Gemini prompt', {
        model: 'gemini-2.5-flash-image',
        output: 'gemini.png',
        aspect: '16:9',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: 'gemini-2.5-flash-image',
        contents: 'A Gemini prompt',
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '16:9',
          },
        },
      });
      expect(writeFileSync).toHaveBeenCalledWith('gemini.png', expect.any(Buffer));
    });

    it('includes resolution for 2K/4K', async () => {
      const mockImageData = Buffer.from('hi-res image').toString('base64');
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{
              inlineData: { data: mockImageData, mimeType: 'image/png' },
            }],
          },
        }],
      });

      await generateImage('Hi-res prompt', {
        model: 'gemini-3-pro-image',
        resolution: '4K',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            imageConfig: {
              aspectRatio: '1:1',
              imageSize: '4K',
            },
          }),
        })
      );
    });

    it('handles text response', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ text: 'Model text response' }],
          },
        }],
      });

      await expect(
        generateImage('test', { model: 'gemini-2.5-flash-image' })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model text response')
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('No image in response')
      );
    });
  });

  describe('prompt reading', () => {
    it('reads prompt from .txt file when it exists', async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path).endsWith('.txt');
      });
      vi.mocked(readFileSync).mockReturnValue('Prompt from file\n');
      mockGenerateImages.mockResolvedValue({
        generatedImages: [{ image: { imageBytes: 'dGVzdA==' } }],
      });

      await generateImage('prompt.txt', { model: 'imagen-4' });

      expect(mockGenerateImages).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Prompt from file',
        })
      );
    });

    it('uses literal string when .txt file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      mockGenerateImages.mockResolvedValue({
        generatedImages: [{ image: { imageBytes: 'dGVzdA==' } }],
      });

      await generateImage('nonexistent.txt', { model: 'imagen-4' });

      expect(mockGenerateImages).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'nonexistent.txt',
        })
      );
    });
  });

  describe('model aliases', () => {
    it('resolves gemini-3-pro-image alias', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('test', { model: 'gemini-3-pro-image' });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3-pro-image-preview',
        })
      );
    });
  });
});
