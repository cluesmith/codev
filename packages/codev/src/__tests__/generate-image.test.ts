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
import {
  generateImage,
  generateViaAtlas,
  generateViaMuapi,
  GenerateImageOptions,
} from '../commands/generate-image.js';

describe('generate-image', () => {
  const originalEnv = process.env;
  const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as () => never);
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    // A copy, so a test that sets or deletes a key cannot leak into the next
    // one or into the real environment; afterEach puts the original back.
    process.env = { ...originalEnv, GEMINI_API_KEY: 'test-api-key' };
    delete process.env.ATLASCLOUD_API_KEY;
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

    // A recognisable JPEG header. Not Buffer.from(array): its .buffer is a
    // pooled ArrayBuffer with an offset, so slicing it from 0 would hand back
    // the wrong bytes.
    const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    type FetchCall = { url: string; init?: RequestInit };

    /**
     * Install a fetch stub over the three Atlas hops and record every call.
     *
     * `polls` is consumed one entry per poll; the last entry repeats.
     */
    function stubAtlas(options: {
      submit?: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> };
      polls?: Array<Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }>;
      download?: Partial<Response> & {
        arrayBuffer?: () => Promise<ArrayBuffer>;
        text?: () => Promise<string>;
      };
    }): FetchCall[] {
      const calls: FetchCall[] = [];
      let pollIndex = 0;
      global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push({ url: href, init });
        if (href.endsWith('/generateImage')) {
          return (options.submit ?? {
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'pred-1', status: 'processing' } }),
          }) as Response;
        }
        if (href.includes('/prediction/')) {
          const polls = options.polls ?? [
            {
              ok: true,
              status: 200,
              json: async () => ({
                data: { status: 'completed', outputs: ['https://cdn.example/a.jpg'] },
              }),
            },
          ];
          const poll = polls[Math.min(pollIndex, polls.length - 1)];
          pollIndex += 1;
          return poll as Response;
        }
        return (options.download ?? {
          ok: true,
          status: 200,
          arrayBuffer: async () => JPEG_BYTES.buffer,
        }) as Response;
      }) as unknown as typeof fetch;
      return calls;
    }

    /** Drive the Atlas path with no sleep between polls. */
    function runAtlas(output = 'output.png', aspect: '1:1' | '16:9' = '1:1') {
      return generateViaAtlas('test prompt', output, aspect, '1K', [], { pollIntervalMs: 0 });
    }

    beforeEach(() => {
      process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';
    });

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
      const calls = stubAtlas({});

      await runAtlas('output.png', '16:9');

      const submitted = JSON.parse(String(calls[0]?.init?.body));
      expect(submitted.aspect_ratio).toBe('16:9');
      expect(submitted.model).toBe('google/nano-banana-pro/text-to-image');
      // api.atlascloud.ai rejects some default User-Agents with 403/1010.
      expect((calls[0]?.init?.headers as Record<string, string>)['User-Agent']).toBeTruthy();
      expect(calls[1]?.url).toContain('/prediction/pred-1');
      // The model returns JPEG, so the .png target must not be used verbatim.
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('output.jpg', expect.anything());
    });

    it('sends the API key to Atlas and never to the CDN', async () => {
      const calls = stubAtlas({});

      await runAtlas();

      const [submit, poll, download] = calls;
      // Read through Headers, not as a plain object: a Headers instance
      // serialises to {}, so an object-only assertion would pass while the
      // credential leaked.
      const authOf = (call?: FetchCall) => new Headers(call?.init?.headers ?? {}).get('authorization');
      expect(authOf(submit)).toBe('Bearer test-atlas-key');
      expect(authOf(poll)).toBe('Bearer test-atlas-key');
      expect(download?.url).toBe('https://cdn.example/a.jpg');
      // The CDN is a different origin: it must not see the credential at all.
      expect(authOf(download)).toBeNull();
      expect(JSON.stringify(download?.init ?? {})).not.toContain('test-atlas-key');
    });

    it('bounds every request with a timeout signal, not merely a signal', async () => {
      // AbortSignal.timeout specifically: a plain AbortController signal is
      // also an AbortSignal but never fires, so asserting the type alone would
      // pass on code that has no deadline at all.
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const calls = stubAtlas({});

      await runAtlas();

      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      }
      // submit, poll, then the larger budget for the image download.
      expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000, 120_000]);
      timeoutSpy.mockRestore();
    });

    it('keeps polling while the prediction is in progress', async () => {
      const calls = stubAtlas({
        polls: [
          { ok: true, status: 200, json: async () => ({ data: { status: 'processing' } }) },
          {
            ok: true,
            status: 200,
            json: async () => ({
              data: { status: 'completed', outputs: ['https://cdn.example/a.jpg'] },
            }),
          },
        ],
      });

      await runAtlas();

      expect(calls.filter((c) => c.url.includes('/prediction/'))).toHaveLength(2);
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('output.jpg', expect.anything());
    });

    it('reports a failed submit', async () => {
      stubAtlas({
        submit: { ok: false, status: 401, text: async () => 'bad key' },
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas submit failed (401): bad key')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('reports a missing prediction id', async () => {
      stubAtlas({
        submit: { ok: true, status: 200, json: async () => ({ data: {} }) },
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('did not return a prediction id')
      );
    });

    it('reports a failed poll', async () => {
      stubAtlas({
        polls: [{ ok: false, status: 500, text: async () => 'upstream boom' }],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas poll failed (500): upstream boom')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('reports a failed prediction', async () => {
      stubAtlas({
        polls: [
          {
            ok: true,
            status: 200,
            json: async () => ({ data: { status: 'failed', error: 'content policy' } }),
          },
        ],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas generation failed: content policy')
      );
    });

    it('fails immediately on an unrecognized status instead of polling to the timeout', async () => {
      const calls = stubAtlas({
        polls: [{ ok: true, status: 200, json: async () => ({ data: { status: 'cancelled' } }) }],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('unrecognized status: cancelled')
      );
      // One poll, not a full ATLAS_TIMEOUT_MS of them reported as a timeout.
      expect(calls.filter((c) => c.url.includes('/prediction/'))).toHaveLength(1);
    });

    it('fails when a completed prediction carries no image URL', async () => {
      stubAtlas({
        polls: [
          { ok: true, status: 200, json: async () => ({ data: { status: 'completed', outputs: [] } }) },
        ],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('completed without an image URL')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('fails when the image URL is not a string', async () => {
      stubAtlas({
        polls: [
          {
            ok: true,
            status: 200,
            json: async () => ({ data: { status: 'completed', outputs: [{ url: 'nested' }] } }),
          },
        ],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('completed without an image URL')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('reports a failed download', async () => {
      stubAtlas({ download: { ok: false, status: 404, text: async () => 'not found' } });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas image download failed (404)')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('refuses to write bytes that are not a recognised image', async () => {
      // A 200 carrying an HTML error body must not land in output.png under a
      // green "Image saved".
      const html = new TextEncoder().encode('<!doctype html><h1>502 Bad Gateway</h1>');
      stubAtlas({
        download: { ok: true, status: 200, arrayBuffer: async () => html.buffer },
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('not a JPEG, PNG or WebP image')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('routes --provider atlas through the Atlas path with the CLI options', async () => {
      // The only test that exercises generateImage -> generateViaAtlas argument
      // passing (the rest call generateViaAtlas directly), so it is what would
      // catch a swapped `output`/`aspect`. Fake timers keep the real 5s poll
      // cadence free.
      vi.useFakeTimers();
      const calls = stubAtlas({});

      const run = generateImage('test prompt', {
        provider: 'atlas',
        aspect: '16:9',
        output: 'dispatch.png',
      } as GenerateImageOptions);
      await vi.advanceTimersByTimeAsync(5000);
      await run;

      expect(JSON.parse(String(calls[0]?.init?.body)).aspect_ratio).toBe('16:9');
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('dispatch.jpg', expect.anything());
    });

    it('gives up when the overall budget is spent instead of polling forever', async () => {
      const calls = stubAtlas({
        polls: [{ ok: true, status: 200, json: async () => ({ data: { status: 'processing' } }) }],
      });

      // The budget expires *during* the first sleep. Checking the deadline
      // before sleeping instead of after would miss that and spend one more
      // request on an already-dead budget.
      await expect(
        generateViaAtlas('test prompt', 'output.png', '1:1', '1K', [], {
          pollIntervalMs: 5,
          timeoutMs: 1,
        })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('timed out after 1ms'));
      expect(calls.filter((c) => c.url.includes('/prediction/'))).toHaveLength(0);
    });

    it('rejects a prediction id that is not a string', async () => {
      stubAtlas({
        submit: { ok: true, status: 200, json: async () => ({ data: { id: 12345 } }) },
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('did not return a prediction id')
      );
    });

    it('reports an HTML error page served as a 200 poll response', async () => {
      // The body read is inside the timeout guard, so a JSON parse failure is
      // reported like any other poll failure instead of escaping as a raw
      // SyntaxError stack.
      stubAtlas({
        polls: [
          {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
            },
          },
        ],
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas poll failed: Unexpected token')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('reports a download aborted mid-stream instead of a raw TimeoutError', async () => {
      // AbortSignal.timeout stays armed while the body streams, so the abort
      // can land on arrayBuffer() rather than on fetch().
      const aborted = new Error('The operation was aborted due to timeout');
      aborted.name = 'TimeoutError';
      stubAtlas({
        download: {
          ok: true,
          status: 200,
          arrayBuffer: async () => {
            throw aborted;
          },
        },
      });

      await expect(runAtlas()).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Atlas image download failed: no response within 120000ms')
      );
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });
  });

  describe('muapi provider', () => {
    const originalFetch = global.fetch;
    const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    type FetchCall = { url: string; init?: RequestInit };

    function stubMuapi(options: {
      polls?: Array<Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }>;
      upload?: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> };
      download?: Partial<Response> & { arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string> };
    } = {}): FetchCall[] {
      const calls: FetchCall[] = [];
      let pollIndex = 0;
      global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        calls.push({ url: href, init });
        if (href.endsWith('/upload_file')) {
          return (options.upload ?? {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://cdn.muapi.ai/input.jpg' }),
          }) as Response;
        }
        if (href.endsWith('/nano-banana-pro') || href.endsWith('/nano-banana-pro-edit')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ request_id: 'muapi-pred-1', status: 'processing' }),
          } as Response;
        }
        if (href.includes('/predictions/')) {
          const polls = options.polls ?? [{
            ok: true,
            status: 200,
            json: async () => ({
              id: 'muapi-pred-1',
              status: 'completed',
              outputs: ['https://cdn.muapi.ai/result.jpg'],
            }),
          }];
          const poll = polls[Math.min(pollIndex, polls.length - 1)];
          pollIndex += 1;
          return poll as Response;
        }
        return (options.download ?? {
          ok: true,
          status: 200,
          arrayBuffer: async () => JPEG_BYTES.buffer,
        }) as Response;
      }) as unknown as typeof fetch;
      return calls;
    }

    beforeEach(() => {
      process.env.MUAPI_API_KEY = 'test-muapi-key';
      delete process.env.MU_API_KEY;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('requires a MuAPI API key', async () => {
      delete process.env.MUAPI_API_KEY;
      delete process.env.MU_API_KEY;

      await expect(
        generateViaMuapi('test prompt', 'output.png', '1:1', '1K', [], { pollIntervalMs: 0 })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('MUAPI_API_KEY or MU_API_KEY environment variable not set')
      );
    });

    it('submits, polls, validates the result URL, and never sends the key to the CDN', async () => {
      const calls = stubMuapi();

      await generateViaMuapi('test prompt', 'output.png', '16:9', '2K', [], { pollIntervalMs: 0 });

      expect(calls.map((call) => call.url)).toEqual([
        'https://api.muapi.ai/api/v1/nano-banana-pro',
        'https://api.muapi.ai/api/v1/predictions/muapi-pred-1/result',
        'https://cdn.muapi.ai/result.jpg',
      ]);
      const submitted = JSON.parse(String(calls[0]?.init?.body));
      expect(submitted).toEqual({
        prompt: 'test prompt',
        aspect_ratio: '16:9',
        resolution: '2k',
      });
      const authOf = (call?: FetchCall) => new Headers(call?.init?.headers ?? {}).get('x-api-key');
      expect(authOf(calls[0])).toBe('test-muapi-key');
      expect(authOf(calls[1])).toBe('test-muapi-key');
      expect(authOf(calls[2])).toBeNull();
      expect(JSON.stringify(calls[2]?.init ?? {})).not.toContain('test-muapi-key');
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('output.jpg', expect.any(Buffer));
    });

    it('uploads local references and switches to the edit model', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('fake image'));
      const calls = stubMuapi();

      await generateViaMuapi('edit this', 'edited.png', '1:1', '1K', ['reference.png'], { pollIntervalMs: 0 });

      expect(calls[0]?.url).toBe('https://api.muapi.ai/api/v1/upload_file');
      expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
      expect(calls[1]?.url).toBe('https://api.muapi.ai/api/v1/nano-banana-pro-edit');
      const submitted = JSON.parse(String(calls[1]?.init?.body));
      expect(submitted.images_list).toEqual(['https://cdn.muapi.ai/input.jpg']);
      expect(submitted.resolution).toBe('1k');
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('edited.jpg', expect.any(Buffer));
    });

    it('fails immediately on an unrecognized prediction status', async () => {
      const calls = stubMuapi({
        polls: [{
          ok: true,
          status: 200,
          json: async () => ({ status: 'cancelled_by_user' }),
        }],
      });

      await expect(
        generateViaMuapi('test prompt', 'output.png', '1:1', '1K', [], { pollIntervalMs: 0 })
      ).rejects.toThrow('process.exit called');
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('unrecognized status: cancelled_by_user')
      );
      expect(calls.filter((call) => call.url.includes('/predictions/'))).toHaveLength(1);
    });
  });
});
