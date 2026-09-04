/**
 * Tests for generate-image command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Mock modules before importing the module under test
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
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

      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('test prompt', {});
      expect(mockGenerateContent).toHaveBeenCalled();
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
        generateImage('test prompt', { ref: ['/nonexistent/image.jpg'] })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Reference image not found')
      );
    });

    it('rejects too many reference images', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const tooManyRefs = Array(15).fill('image.jpg');

      await expect(
        generateImage('test prompt', { ref: tooManyRefs })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Too many reference images')
      );
    });
  });

  describe('Gemini image generation', () => {
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

      await generateImage('A test prompt', {
        output: 'test.png',
        aspect: '16:9',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: 'gemini-3-pro-image-preview',
        contents: 'A test prompt',
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '16:9',
          },
        },
      });
      expect(writeFileSync).toHaveBeenCalledWith('test.png', expect.any(Buffer));
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
        resolution: '4K',
      });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3-pro-image-preview',
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
        generateImage('test', {})
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Model text response')
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('No image in response')
      );
    });

    it('handles empty candidates', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [],
      });

      await expect(
        generateImage('test', {})
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('No response candidates')
      );
    });
  });

  describe('prompt reading', () => {
    it('reads prompt from .txt file when it exists', async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path).endsWith('.txt');
      });
      vi.mocked(readFileSync).mockReturnValue('Prompt from file\n');
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('prompt.txt', {});

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: 'Prompt from file',
        })
      );
    });

    it('uses literal string when .txt file does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('nonexistent.txt', {});

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: 'nonexistent.txt',
        })
      );
    });
  });

  describe('reference images', () => {
    it('includes single reference image in contents', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('fake image data'));
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('Edit this image', { ref: ['reference.png'] });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: expect.arrayContaining([
            expect.objectContaining({
              inlineData: expect.objectContaining({
                mimeType: 'image/png',
              }),
            }),
            'Edit this image',
          ]),
        })
      );
    });

    it('includes multiple reference images in contents', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('fake image data'));
      mockGenerateContent.mockResolvedValue({
        candidates: [{
          content: {
            parts: [{ inlineData: { data: 'dGVzdA==', mimeType: 'image/png' } }],
          },
        }],
      });

      await generateImage('Combine these images', { ref: ['img1.png', 'img2.jpg', 'img3.webp'] });

      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.contents).toHaveLength(4); // 3 images + 1 prompt
      expect(call.contents[0].inlineData.mimeType).toBe('image/png');
      expect(call.contents[1].inlineData.mimeType).toBe('image/jpeg');
      expect(call.contents[2].inlineData.mimeType).toBe('image/webp');
      expect(call.contents[3]).toBe('Combine these images');
    });
  });

  describe('atlas provider', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      vi.useRealTimers();
    });

    it('exits with error when ATLASCLOUD_API_KEY is not set', async () => {
      delete process.env.ATLASCLOUD_API_KEY;

      await expect(
        generateImage('test prompt', { provider: 'atlas' } as GenerateImageOptions)
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('ATLASCLOUD_API_KEY environment variable not set')
      );
    });

    it('rejects an unknown provider', async () => {
      await expect(
        generateImage('test prompt', { provider: 'nope' } as GenerateImageOptions)
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid provider 'nope'")
      );
    });

    it('refuses reference images instead of ignoring them', async () => {
      process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(
        generateImage('test prompt', {
          provider: 'atlas',
          ref: ['style.png'],
        } as GenerateImageOptions)
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('--ref is not supported with --provider atlas')
      );
    });

    it('submits aspect_ratio, polls the prediction and names the file after its bytes', async () => {
      process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';
      // Not Buffer.from(array): its .buffer is a pooled ArrayBuffer with an
      // offset, so slicing it from 0 would hand back the wrong bytes.
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push({ url: href, init });
        if (href.endsWith('/generateImage')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'pred-1', status: 'processing' } }),
          } as Response;
        }
        if (href.includes('/prediction/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: { status: 'completed', outputs: ['https://cdn.example/a.jpg'] },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => jpeg.buffer,
        } as Response;
      }) as unknown as typeof fetch;

      await generateImage('test prompt', {
        provider: 'atlas',
        aspect: '16:9',
        output: 'output.png',
      } as GenerateImageOptions);

      const submitted = JSON.parse(String(calls[0]?.init?.body));
      expect(submitted.aspect_ratio).toBe('16:9');
      expect(submitted.model).toBe('google/nano-banana-pro/text-to-image');
      // api.atlascloud.ai rejects some default User-Agents with 403/1010.
      expect((calls[0]?.init?.headers as Record<string, string>)['User-Agent']).toBeTruthy();
      expect(calls[1]?.url).toContain('/prediction/pred-1');
      // The model returns JPEG, so the .png target must not be used verbatim.
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('output.jpg', expect.anything());
    }, 20000);

    it('reports a failed prediction', async () => {
      process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';
      global.fetch = vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.endsWith('/generateImage')) {
          return { ok: true, status: 200, json: async () => ({ data: { id: 'pred-2' } }) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { status: 'failed', error: 'content policy' } }),
        } as Response;
      }) as unknown as typeof fetch;

      await expect(
        generateImage('test prompt', { provider: 'atlas' } as GenerateImageOptions)
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas generation failed: content policy')
      );
    }, 20000);
  });
});
