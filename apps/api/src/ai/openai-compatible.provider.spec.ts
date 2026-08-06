import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { GroqProvider } from './groq.provider';
import {
  failedGeneration,
  retryDelayMs,
  safeJsonParse,
  stripReasoning,
} from './openai-compatible.provider';
import { XaiProvider } from './xai.provider';

/**
 * The shared OpenAI-compatible client, exercised through both vendor configs.
 *
 * No test here talks to a real API. What is worth asserting is the shape of
 * what we send, how the two vendors differ, and how a malformed or rate-limited
 * response is treated — a bad response must fail the step rather than write
 * half-understood output into a document's summary and search index.
 */

const BASE: Partial<Env> = {
  AI_REQUEST_TIMEOUT_MS: 5000,
  AI_MAX_SUMMARY_CHARS: 100,
  GROQ_API_KEY: 'gsk_test',
  GROQ_MODEL: 'llama-3.3-70b-versatile',
  GROQ_VISION_MODEL: 'qwen/qwen3.6-27b',
  GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
  XAI_API_KEY: 'xai_test',
  XAI_MODEL: 'grok-4.5',
  XAI_BASE_URL: 'https://api.x.ai/v1',
};

function configOf(overrides: Partial<Env> = {}) {
  const env = { ...BASE, ...overrides };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

/** The chat-completions envelope both vendors return. */
function completion(content: string, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    text: () => Promise.resolve(''),
  };
}

function lastBody(mock: jest.Mock): Record<string, unknown> {
  const [, init] = mock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const IMAGE = { data: Buffer.from('image-bytes'), mimeType: 'image/png', page: 1 };

describe('OpenAI-compatible providers', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  describe('vendor differences', () => {
    it('Groq uses a separate vision model, because its text models reject images', async () => {
      fetchMock.mockResolvedValue(completion('transcribed'));
      const groq = new GroqProvider(configOf());

      await groq.ocr([IMAGE]);
      expect(lastBody(fetchMock).model).toBe('qwen/qwen3.6-27b');

      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));
      await groq.summarise('hello');
      expect(lastBody(fetchMock).model).toBe('llama-3.3-70b-versatile');
    });

    it('xAI uses one model for both', async () => {
      fetchMock.mockResolvedValue(completion('transcribed'));
      const xai = new XaiProvider(configOf());

      await xai.ocr([IMAGE]);
      expect(lastBody(fetchMock).model).toBe('grok-4.5');

      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));
      await xai.summarise('hello');
      expect(lastBody(fetchMock).model).toBe('grok-4.5');
    });

    it('posts to each vendor’s own base URL with a bearer token', async () => {
      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));

      await new GroqProvider(configOf()).summarise('hi');
      let [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');

      await new XaiProvider(configOf()).summarise('hi');
      [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(url).toBe('https://api.x.ai/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai_test');
    });

    it('reports the vendors’ different image ceilings', () => {
      // The rasteriser reads this to decide how far to downscale a page.
      expect(new GroqProvider(configOf()).maxImageBytes).toBe(4 * 1024 * 1024);
      expect(new XaiProvider(configOf()).maxImageBytes).toBe(10 * 1024 * 1024);
    });
  });

  describe('vision availability', () => {
    it('is off when Groq’s vision model is blank', async () => {
      const groq = new GroqProvider(configOf({ GROQ_VISION_MODEL: '  ' }));

      expect(groq.supportsVision).toBe(false);
      // No request at all — not an error, just nothing it can read.
      await expect(groq.ocr([IMAGE])).resolves.toEqual({ text: '', pages: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is on when a vision model is configured', () => {
      expect(new GroqProvider(configOf()).supportsVision).toBe(true);
    });
  });

  describe('reasoning models', () => {
    it('asks Groq to withhold chain-of-thought', async () => {
      fetchMock.mockResolvedValue(completion('text'));

      await new GroqProvider(configOf()).ocr([IMAGE]);

      // Qwen narrates inside <think> tags by default; that text would be stored
      // as the document's contents and indexed for search.
      expect(lastBody(fetchMock).reasoning_format).toBe('hidden');
    });

    it('applies it to summaries too, not only vision', async () => {
      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));

      // The operator can point the text model at a reasoning model as well.
      await new GroqProvider(configOf()).summarise('hi');

      expect(lastBody(fetchMock).reasoning_format).toBe('hidden');
    });

    it('does not send the flag to xAI, which does not support it', async () => {
      fetchMock.mockResolvedValue(completion('text'));

      await new XaiProvider(configOf()).ocr([IMAGE]);

      expect(lastBody(fetchMock).reasoning_format).toBeUndefined();
    });

    it('drops the flag and retries when the model rejects it', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('`reasoning_format` is not supported with this model'),
        })
        .mockResolvedValue(completion('{"summary":"ok"}'));

      const groq = new GroqProvider(configOf({ GROQ_MODEL: 'llama-3.3-70b-versatile' }));

      await expect(groq.summarise('hi')).resolves.toEqual({ summary: 'ok' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(lastBody(fetchMock).reasoning_format).toBeUndefined();
    });

    it('remembers the rejection, so it costs one request per model, not one per call', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('`reasoning_format` is not supported with this model'),
        })
        .mockResolvedValue(completion('{"summary":"ok"}'));

      const groq = new GroqProvider(configOf({ GROQ_MODEL: 'llama-3.3-70b-versatile' }));

      await groq.summarise('one');
      await groq.summarise('two');

      // 400 + retry, then a single clean call — not another rejected probe.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not swallow an unrelated 400', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('messages[0].content must be a string'),
      });

      await expect(new GroqProvider(configOf()).summarise('hi')).rejects.toThrow(
        /must be a string/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('strips a <think> block that survived anyway', async () => {
      fetchMock.mockResolvedValue(
        completion('<think>The user wants a transcription…</think>INVOICE No. 4471'),
      );

      const result = await new GroqProvider(configOf()).ocr([IMAGE]);

      expect(result.text).toBe('INVOICE No. 4471');
    });

    it('drops a page whose token budget ran out rather than recording it blank', async () => {
      // A reasoning model that spent its whole allowance thinking returns an
      // empty string with finish_reason 'length'.
      fetchMock.mockResolvedValue(completion('', 'length'));

      const result = await new GroqProvider(configOf()).ocr([IMAGE]);

      expect(result).toEqual({ text: '', pages: 0 });
    });
  });

  describe('rate limiting', () => {
    it('waits the interval the vendor asked for, then retries', async () => {
      jest.useFakeTimers();

      const rateLimited = {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: () => Promise.resolve('Rate limit reached. Please try again in 1.5s'),
      };

      fetchMock.mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(completion('recovered'));

      const pending = new GroqProvider(configOf()).ocr([IMAGE]);

      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;

      // 429 is the expected steady state on a free tier, not an exception.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.text).toBe('recovered');

      jest.useRealTimers();
    });

    it('prefers the Retry-After header when present', () => {
      const response = { headers: { get: (h: string) => (h === 'retry-after' ? '3' : null) } };

      expect(retryDelayMs(response as never, '')).toBe(3000);
    });

    it('falls back to the interval named in the body', () => {
      const response = { headers: { get: () => null } };

      // 21877, not 21878: 21.877 * 1000 is 21876.99… in binary floating point.
      expect(retryDelayMs(response as never, 'Please try again in 21.877s')).toBe(21877);
    });

    it('returns null when the vendor said nothing useful', () => {
      const response = { headers: { get: () => null } };

      expect(retryDelayMs(response as never, 'slow down')).toBeNull();
    });

    it('keeps the pages it already read when a later one fails', async () => {
      fetchMock
        .mockResolvedValueOnce(completion('page one'))
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

      const result = await new GroqProvider(configOf()).ocr([
        IMAGE,
        { ...IMAGE, page: 2 },
        { ...IMAGE, page: 3 },
      ]);

      /**
       * Partial text beats none: failing outright would discard work already
       * paid for and re-spend it on the retry.
       */
      expect(result).toEqual({ text: 'page one', pages: 1 });
    });
  });

  describe('summarise', () => {
    it('asks for JSON at the protocol level, not only in the prompt', async () => {
      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));

      await new GroqProvider(configOf()).summarise('hello');

      expect(lastBody(fetchMock).response_format).toEqual({ type: 'json_object' });
    });

    it('truncates the body to the configured budget', async () => {
      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));

      await new GroqProvider(configOf()).summarise('x'.repeat(500));

      const messages = lastBody(fetchMock).messages as { role: string; content: string }[];

      expect(messages.find((m) => m.role === 'user')?.content).toHaveLength(100);
    });

    it('parses a well-formed response', async () => {
      fetchMock.mockResolvedValue(
        completion('{"summary":"An invoice.","keywords":["invoice"],"language":"en"}'),
      );

      await expect(new GroqProvider(configOf()).summarise('hi')).resolves.toEqual({
        summary: 'An invoice.',
        keywords: ['invoice'],
        language: 'en',
      });
    });

    it.each([
      ['prose instead of JSON', 'Here is a summary of the document.'],
      ['a wrong-typed field', '{"keywords":"not-an-array"}'],
      ['nothing at all', ''],
    ])('fails on %s rather than coercing it', async (_label, body) => {
      fetchMock.mockResolvedValue(completion(body));

      await expect(new GroqProvider(configOf()).summarise('hi')).rejects.toThrow();
    });
  });

  describe('ocr', () => {
    it('sends one request per page, so a single failure costs one page', async () => {
      fetchMock.mockResolvedValue(completion('page text'));

      const result = await new GroqProvider(configOf()).ocr([IMAGE, { ...IMAGE, page: 2 }]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ text: 'page text\n\npage text', pages: 2 });
    });

    it('encodes the image as a base64 data URL', async () => {
      fetchMock.mockResolvedValue(completion('text'));

      await new GroqProvider(configOf()).ocr([IMAGE]);

      const messages = lastBody(fetchMock).messages as { role: string; content: unknown }[];
      const [part] = messages.find((m) => m.role === 'user')?.content as {
        image_url: { url: string };
      }[];

      expect(part.image_url.url).toBe(
        `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
      );
    });

    it('skips an oversized page instead of failing the whole document', async () => {
      fetchMock.mockResolvedValue(completion('small page'));

      const result = await new GroqProvider(configOf()).ocr([
        { data: Buffer.alloc(5 * 1024 * 1024), mimeType: 'image/png', page: 1 },
        { ...IMAGE, page: 2 },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.pages).toBe(1);
    });
  });

  describe('transport', () => {
    it('sets an abort signal, so a hung provider cannot pin a worker slot', async () => {
      fetchMock.mockResolvedValue(completion('{"summary":"ok"}'));

      await new GroqProvider(configOf()).summarise('hi');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('surfaces the response body on a 4xx, where the useful detail lives', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('messages[0].content must be a string'),
      });

      await expect(new GroqProvider(configOf()).summarise('hi')).rejects.toThrow(
        /400.*must be a string/,
      );
    });

    it('names the provider on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));

      await expect(new GroqProvider(configOf()).summarise('hi')).rejects.toThrow(
        /groq request failed/,
      );
    });
  });

  describe('embed', () => {
    it('returns null for both, because neither publishes an embeddings endpoint', async () => {
      // Search stays on Postgres full text rather than ranking against noise.
      await expect(new GroqProvider(configOf()).embed()).resolves.toBeNull();
      await expect(new XaiProvider(configOf()).embed()).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Groq’s server-side JSON validation', () => {
    it('recovers the summary from a json_validate_failed rejection', async () => {
      // Groq enforces JSON mode itself and 400s when the output does not parse,
      // but hands back what the model produced.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: {
                code: 'json_validate_failed',
                message: "Failed to validate JSON. See 'failed_generation'.",
                failed_generation: '```json\n{"summary":"An agreement.","language":"en"}\n```',
              },
            }),
          ),
      });

      // Discarding a summary the model genuinely produced, over a code fence,
      // would fail the document for no reason.
      await expect(new GroqProvider(configOf()).summarise('hi')).resolves.toEqual({
        summary: 'An agreement.',
        language: 'en',
      });
    });

    it('still fails when the salvaged text does not satisfy the schema', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { code: 'json_validate_failed', failed_generation: 'I cannot do that.' },
            }),
          ),
      });

      // Recovery is not a bypass — the schema still gates what reaches the row.
      await expect(new GroqProvider(configOf()).summarise('hi')).rejects.toThrow();
    });

    it('extracts the generation only from that error shape', () => {
      expect(
        failedGeneration(
          JSON.stringify({ error: { code: 'json_validate_failed', failed_generation: '{"a":1}' } }),
        ),
      ).toBe('{"a":1}');

      expect(
        failedGeneration(JSON.stringify({ error: { code: 'rate_limit_exceeded' } })),
      ).toBeNull();
      expect(failedGeneration('<html>502 Bad Gateway</html>')).toBeNull();
    });
  });

  describe('helpers', () => {
    it('strips an unclosed <think> left by a truncated response', () => {
      expect(stripReasoning('<think>still thinking about')).toBe('');
    });

    it('leaves ordinary text alone', () => {
      expect(stripReasoning('  INVOICE 4471  ')).toBe('INVOICE 4471');
    });

    it('unwraps JSON a model fenced despite being told not to', () => {
      expect(safeJsonParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('returns null for unparseable JSON, so validation rejects it upstream', () => {
      expect(safeJsonParse('not json')).toBeNull();
    });
  });
});
