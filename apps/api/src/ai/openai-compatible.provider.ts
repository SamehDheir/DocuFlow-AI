import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiProvider, OcrImage, OcrResult, SummaryResult } from './ai-provider.interface';

/**
 * The shared client for any vendor that speaks the OpenAI chat-completions wire
 * format — which is currently both of them, xAI and Groq.
 *
 * Written once here rather than twice because the vendors differ only in
 * configuration: a base URL, which model reads images, and whether that model
 * narrates its own reasoning. Everything that is actually hard — the timeout,
 * the rate-limit backoff, the JSON validation, the refusal to coerce a
 * malformed response — is the same work, and having one copy of it means a fix
 * lands for both.
 *
 * No vendor SDK. This is one POST and a zod parse; wrapping it in a dependency
 * would add a release cadence and a breaking-change surface for no gain.
 */

/** Everything that varies between vendors. */
export interface OpenAiCompatibleConfig {
  /** Recorded in `DocumentMetadata.aiModel`, so output can be attributed. */
  name: string;
  apiKey: string;
  baseUrl: string;
  /** Summaries and any other text-only work. */
  textModel: string;
  /**
   * The model that accepts images, or null when the vendor has none.
   *
   * Null is a real configuration, not a defect: it makes `supportsVision` false
   * and the extractor stops rasterising scans it has no way to read.
   */
  visionModel: string | null;
  /** Vendor ceiling per image. */
  maxImageBytes: number;
  timeoutMs: number;
  maxSummaryChars: number;
  /**
   * Completion budget for one OCR page.
   *
   * Generous on purpose. A reasoning model spends this allowance thinking
   * before it answers, and too small a budget returns an empty string with
   * `finish_reason: length` — a silent truncation that looks like a blank page.
   */
  maxOcrTokens: number;
  /**
   * Try to make the vendor withhold chain-of-thought.
   *
   * Qwen on Groq narrates its reasoning inside <think> tags by default. That
   * text would be stored as the document's contents and indexed for search, so
   * a user searching their archive would match the model's musings about an
   * invoice rather than the invoice.
   *
   * "Try" is the operative word — the flag is per-model, not per-vendor, and
   * sending it to a model that does not reason is a hard 400 ("`reasoning_format`
   * is not supported with this model"). Since which model does what is the
   * operator's choice, the capability is discovered at runtime rather than
   * hardcoded. See `unsupportedReasoningModels`.
   */
  hideReasoning: boolean;
}

const summarySchema = z.object({
  summary: z.string().min(1).optional(),
  keywords: z.array(z.string().min(1)).max(12).optional(),
  language: z.string().min(2).max(12).optional(),
  title: z.string().min(1).max(200).optional(),
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const OCR_SYSTEM_PROMPT = [
  'You are an OCR engine. Transcribe every character visible in the image.',
  'Preserve the reading order and line breaks.',
  'The text may be Arabic, English, or both in the same document — transcribe each in its own script.',
  'Do not translate. Do not summarise. Do not describe the image. Do not explain your reasoning.',
  'Output only the transcribed text, with no commentary and no code fences.',
].join(' ');

const SUMMARY_SYSTEM_PROMPT = [
  'You analyse business documents.',
  'Reply with a single JSON object and nothing else, using exactly these keys:',
  '"summary" (2-4 sentences, in the same language as the document),',
  '"keywords" (up to 8 short topical terms, in the document language),',
  '"language" (BCP-47 tag of the dominant language, e.g. "en" or "ar"),',
  '"title" (a short descriptive title for the document).',
  'Omit any key you cannot determine. Never invent facts absent from the text.',
].join(' ');

/** Bounded, because a worker slot held open helps nobody. */
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 60_000;

export abstract class OpenAiCompatibleProvider implements AiProvider {
  protected readonly logger: Logger;

  /**
   * Models observed to reject `reasoning_format`.
   *
   * Learned from the vendor's own 400 rather than guessed from the model name.
   * A name-based list would be wrong the day either vendor renames a model or
   * the operator points GROQ_MODEL at something new — and being wrong here
   * means every summary fails. Discovering it costs one rejected request per
   * model per process lifetime.
   */
  private readonly unsupportedReasoningModels = new Set<string>();

  constructor(private readonly settings: OpenAiCompatibleConfig) {
    this.logger = new Logger(`${settings.name}Provider`);
  }

  get name(): string {
    return this.settings.name;
  }

  readonly available = true;

  get supportsVision(): boolean {
    return this.settings.visionModel !== null;
  }

  get maxImageBytes(): number {
    return this.settings.maxImageBytes;
  }

  /**
   * One request per page rather than all pages in one message.
   *
   * A twenty-page scan in a single call risks the context limit and loses the
   * whole job when it trips; one failed page costs one page. It also keeps each
   * request small enough to fit inside a free tier's per-minute token budget,
   * which a batched call would blow through immediately.
   */
  async ocr(images: OcrImage[]): Promise<OcrResult> {
    const { visionModel, maxImageBytes } = this.settings;

    if (!visionModel) {
      // Reached only if a caller ignored supportsVision. Empty, not an error:
      // a document the model cannot read is still a document.
      this.logger.warn(`${this.name} has no vision model configured; skipping OCR`);
      return { text: '', pages: 0 };
    }

    const pages: string[] = [];

    for (const image of images) {
      if (image.data.length > maxImageBytes) {
        // The rasteriser downscales to stay under this. Skip rather than throw:
        // one oversized page must not cost the other nineteen.
        this.logger.warn(
          `Skipping page ${image.page}: ${image.data.length} bytes exceeds the ${maxImageBytes} byte limit`,
        );
        continue;
      }

      try {
        const text = await this.complete(
          visionModel,
          [
            { role: 'system', content: OCR_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.data.toString('base64')}`,
                  },
                },
              ],
            },
          ],
          { max_tokens: this.settings.maxOcrTokens },
        );

        const cleaned = stripReasoning(text);

        if (cleaned) {
          pages.push(cleaned);
        }
      } catch (error) {
        /**
         * Partial text beats none.
         *
         * On a free tier a long scan will exhaust the per-minute token budget
         * partway through. Failing the document would discard the pages already
         * read and re-spend them on the retry; keeping them means the document
         * is searchable now and can be reprocessed for the rest.
         */
        this.logger.warn(
          `OCR failed on page ${image.page} after ${pages.length} successful pages: ${(error as Error).message}`,
        );
        break;
      }
    }

    return { text: pages.join('\n\n'), pages: pages.length };
  }

  async summarise(text: string): Promise<SummaryResult> {
    /**
     * Truncated from the front. Business documents put their subject, parties
     * and date at the top, so the opening carries the signal — and an unbounded
     * body is both expensive and liable to blow the context window on a scan.
     */
    const body = text.slice(0, this.settings.maxSummaryChars);

    const raw = await this.complete(
      this.settings.textModel,
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: body },
      ],
      // Ask for JSON at the protocol level, not only in the prompt.
      { response_format: { type: 'json_object' } },
    );

    const parsed = summarySchema.safeParse(safeJsonParse(stripReasoning(raw)));

    if (!parsed.success) {
      /**
       * A malformed response fails the step rather than being coerced. Writing
       * half-understood output into `summary` would put text of unknown
       * provenance in front of the user and into the search index, which is
       * worse than an honest FAILED status they can retry.
       */
      throw new Error(`Summary response did not match the expected shape: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  /**
   * Neither vendor publishes an embeddings endpoint.
   *
   * Null rather than a fabricated vector: search stays on Postgres full text,
   * where it works, instead of ranking against noise.
   */
  embed(): Promise<number[] | null> {
    return Promise.resolve(null);
  }

  /** The single HTTP call every capability above goes through. */
  private async complete(
    model: string,
    messages: ChatMessage[],
    extra: Record<string, unknown> = {},
    attempt = 0,
  ): Promise<string> {
    /**
     * Applied to every call, not just vision: the operator can point the text
     * model at a reasoning model too, and an unsuppressed <think> block in a
     * summary is the same problem as one in extracted text.
     */
    const hideReasoning =
      this.settings.hideReasoning && !this.unsupportedReasoningModels.has(model);

    let response: Response;

    try {
      response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(hideReasoning ? { reasoning_format: 'hidden' } : {}),
          ...extra,
        }),
        /**
         * A hung request must not pin a worker slot. QUEUE_CONCURRENCY defaults
         * to 2, so two stalled calls with no timeout would stop the queue for
         * every tenant on this instance.
         */
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      throw new Error(`${this.name} request failed: ${(error as Error).message}`);
    }

    /**
     * 429 is the expected steady state on a free tier, not an exception.
     *
     * Groq's limits are per-minute and one page image can be a third of the
     * budget, so a multi-page scan WILL hit this. The vendor says exactly how
     * long to wait; honouring that is far better than a blind exponential
     * backoff that either gives up too early or sleeps far longer than needed.
     */
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const body = await response.text().catch(() => '');
      const waitMs = retryDelayMs(response, body);

      if (waitMs !== null && waitMs <= MAX_RETRY_WAIT_MS) {
        this.logger.warn(
          `${this.name} rate limited on ${model}; retrying in ${Math.ceil(waitMs / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));

        return this.complete(model, messages, extra, attempt + 1);
      }

      throw new Error(`${this.name} rate limited: ${body.slice(0, 300)}`);
    }

    if (!response.ok) {
      // Body first: the useful part of a 4xx lives there. Bounded, because an
      // error page can be arbitrarily long.
      const detail = await response.text().catch(() => '');

      /**
       * The model does not reason, and said so. Remember that and retry without
       * the flag.
       *
       * This is the whole reason the capability is discovered rather than
       * configured: whether `reasoning_format` is accepted depends on which
       * model the operator pointed GROQ_MODEL at, and getting it wrong would
       * otherwise fail every summary with a 400. One wasted request per model
       * per process buys a configuration that cannot be set up wrongly.
       */
      if (hideReasoning && response.status === 400 && /reasoning_format/i.test(detail)) {
        this.unsupportedReasoningModels.add(model);
        this.logger.log(
          `${model} does not support reasoning_format; continuing without it and stripping any <think> blocks`,
        );

        return this.complete(model, messages, extra, attempt);
      }

      /**
       * Groq enforces JSON mode server-side and returns a 400 when the model's
       * output does not parse — but it attaches the generation it rejected.
       *
       * Salvage it. The text is usually valid JSON wrapped in something (a code
       * fence, a reasoning preamble) that the vendor's strict parser refused,
       * and the callers here already tolerate exactly that. Discarding a
       * summary the model genuinely produced, over a wrapper, would fail the
       * step for no reason. It still has to satisfy the schema upstream, so
       * nothing unvalidated reaches the database.
       */
      const salvaged = failedGeneration(detail);

      if (salvaged) {
        this.logger.warn(
          `${model} returned JSON that ${this.name} rejected; recovering the generation it sent back`,
        );

        return salvaged;
      }

      throw new Error(`${this.name} returned ${response.status}: ${detail.slice(0, 500)}`);
    }

    const parsed = completionSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error(
        `${this.name} returned an unrecognised response shape: ${parsed.error.message}`,
      );
    }

    const choice = parsed.data.choices[0];

    if (choice.finish_reason === 'length' && !choice.message.content?.trim()) {
      /**
       * A reasoning model that spent its whole allowance thinking returns an
       * empty string with finish_reason 'length'. Silently storing that would
       * record a blank page as successfully read.
       */
      throw new Error(
        `${this.name} exhausted its token budget on ${model} before producing any output`,
      );
    }

    return choice.message.content ?? '';
  }
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | unknown[];
};

/**
 * Removes a reasoning model's chain-of-thought.
 *
 * Belt and braces: `reasoning_format: 'hidden'` already suppresses it at the
 * vendor, but that parameter is not universal and a model that ignores it would
 * otherwise have its internal monologue stored as the document's contents.
 */
export function stripReasoning(raw: string): string {
  return (
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // An unclosed tag means the budget ran out mid-thought; everything after it
      // is reasoning, not answer.
      .replace(/<think>[\s\S]*$/i, '')
      .trim()
  );
}

/**
 * Pulls the rejected generation out of a Groq `json_validate_failed` body.
 *
 * Returns null for every other error shape, so an ordinary 400 still throws.
 */
export function failedGeneration(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; failed_generation?: unknown };
    };

    if (
      parsed.error?.code === 'json_validate_failed' &&
      typeof parsed.error.failed_generation === 'string' &&
      parsed.error.failed_generation.trim()
    ) {
      return parsed.error.failed_generation;
    }
  } catch {
    // Not JSON — an HTML error page, a proxy timeout. Nothing to recover.
  }

  return null;
}

/**
 * How long the vendor asked us to wait.
 *
 * Prefers the standard header, then the human-readable hint Groq puts in the
 * error body ("Please try again in 21.877s"), which is often more precise.
 */
export function retryDelayMs(response: Pick<Response, 'headers'>, body: string): number | null {
  const header = response.headers?.get?.('retry-after');

  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.ceil(seconds * 1000);
    }
  }

  const match = /try again in ([\d.]+)\s*s/i.exec(body);

  if (match) {
    return Math.ceil(Number(match[1]) * 1000);
  }

  return null;
}

/**
 * Tolerates a model that wrapped its JSON in a code fence despite being asked
 * not to — common enough that rejecting it would cost real summaries for no
 * benefit. Anything else still fails validation upstream.
 */
export function safeJsonParse(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}
