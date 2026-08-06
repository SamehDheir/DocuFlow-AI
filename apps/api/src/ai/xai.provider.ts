import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

/**
 * xAI (Grok), on the OpenAI wire format.
 *
 * Not to be confused with Groq, the other provider in this folder. Different
 * company, different API, one letter apart.
 *
 * Unlike Groq, a single Grok model handles both text and images, so the text
 * and vision models are the same value. Vision input is still IMAGES ONLY —
 * jpg or png, no native PDF — which is why TextExtractorService parses a PDF's
 * text layer first and rasterises only a true scan.
 *
 * xAI publishes no embeddings endpoint, so `embed()` returns null.
 */

/** xAI's documented ceiling per image. */
export const XAI_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class XaiProvider extends OpenAiCompatibleProvider {
  constructor(config: ConfigService<Env, true>) {
    const model = config.get('XAI_MODEL', { infer: true });

    super({
      name: 'xai',
      // Constructed only by the factory in ai.module.ts, which checks the key
      // first and falls back to NullAiProvider when it is absent.
      apiKey: config.get('XAI_API_KEY', { infer: true }) ?? '',
      baseUrl: config.get('XAI_BASE_URL', { infer: true }).replace(/\/+$/, ''),
      textModel: model,
      // One model does both.
      visionModel: model,
      maxImageBytes: XAI_MAX_IMAGE_BYTES,
      timeoutMs: config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }),
      maxSummaryChars: config.get('AI_MAX_SUMMARY_CHARS', { infer: true }),
      maxOcrTokens: 4000,
      // Grok does not wrap its answers in reasoning tags.
      hideReasoning: false,
    });
  }
}
