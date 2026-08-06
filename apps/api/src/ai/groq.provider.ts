import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

/**
 * Groq — LPU inference serving open models, on the OpenAI wire format.
 *
 * Not to be confused with xAI's Grok. Different company, different API, and the
 * names are one letter apart.
 *
 * WHAT MAKES GROQ DIFFERENT FROM THE OTHER PROVIDER HERE:
 *
 *   1. TWO MODELS, NOT ONE. Groq's text models reject image content outright
 *      ("messages[0].content must be a string"); only the Qwen multimodal model
 *      accepts it. So summaries and OCR go to different models, where xAI uses
 *      one for both.
 *   2. THE VISION MODEL REASONS OUT LOUD. Qwen narrates inside <think> tags by
 *      default, which would be stored as the document's text and indexed. Hence
 *      `hideReasoning`.
 *   3. THE FREE TIER IS GENUINELY TIGHT. Measured: 8,000 tokens per minute on
 *      the vision model, against roughly 1,200-3,000 tokens for a single page
 *      image — a handful of pages a minute. The base class honours the vendor's
 *      own Retry-After and keeps whatever pages it managed to read, which is
 *      what makes that survivable rather than a hard failure.
 *
 * There is no embeddings model on the free tier, so `embed()` returns null and
 * search stays on Postgres full text.
 */

/**
 * Groq's per-image ceiling for base64 payloads.
 *
 * 4 MB rather than xAI's 10 MB, and the rasteriser is told this so pages are
 * downscaled to fit before a request is ever built.
 */
export const GROQ_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

@Injectable()
export class GroqProvider extends OpenAiCompatibleProvider {
  constructor(config: ConfigService<Env, true>) {
    const visionModel = config.get('GROQ_VISION_MODEL', { infer: true });

    super({
      name: 'groq',
      // Constructed only by the factory in ai.module.ts, which checks the key
      // first and falls back to NullAiProvider when it is absent.
      apiKey: config.get('GROQ_API_KEY', { infer: true }) ?? '',
      baseUrl: config.get('GROQ_BASE_URL', { infer: true }).replace(/\/+$/, ''),
      textModel: config.get('GROQ_MODEL', { infer: true }),
      // Blank disables OCR rather than failing: a deployment that only wants
      // summaries should not have to pretend it has a vision model.
      visionModel: visionModel.trim() || null,
      maxImageBytes: GROQ_MAX_IMAGE_BYTES,
      timeoutMs: config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }),
      maxSummaryChars: config.get('AI_MAX_SUMMARY_CHARS', { infer: true }),
      /**
       * Measured against Qwen: a page of text costs under 200 completion
       * tokens once reasoning is hidden, but the model still needs headroom to
       * think first. At 1,200 it returned complete transcriptions; below that
       * it returns an empty string with finish_reason 'length'.
       */
      maxOcrTokens: 1200,
      hideReasoning: true,
    });
  }
}
