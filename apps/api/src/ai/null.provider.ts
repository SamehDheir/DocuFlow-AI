import { Injectable, Logger } from '@nestjs/common';
import type { AiProvider, OcrImage, OcrResult, SummaryResult } from './ai-provider.interface';

/**
 * The provider used when no API key is configured.
 *
 * Not a disabled stub that throws — a working one that returns plausible,
 * deterministic output. The difference matters:
 *
 *   - CI has no credential, and a pipeline that fails without one would mean
 *     the queue, the status transitions, the notifications and the search
 *     indexing are all untested.
 *   - The e2e suite stays offline, so tests are fast and cannot flake on a
 *     vendor outage or a rate limit.
 *   - Anyone cloning the repo gets a system that works end to end before they
 *     have signed up for anything.
 *
 * Output is derived from the input rather than random, so a test can assert on
 * it. It is also unmistakably labelled: silently passing fake summaries off as
 * real analysis would be worse than having none.
 */
@Injectable()
export class NullAiProvider implements AiProvider {
  readonly name = 'null';
  readonly available = false;
  /**
   * True, so the stub still walks the rasterise-and-OCR path. The point of this
   * provider is that every branch of the pipeline runs without a credential —
   * declaring no vision would leave the scan path untested.
   */
  readonly supportsVision = true;
  /** Matches the smallest real provider, so the stub exercises the same downscaling. */
  readonly maxImageBytes = 4 * 1024 * 1024;

  private readonly logger = new Logger(NullAiProvider.name);

  constructor() {
    this.logger.warn(
      'No AI key configured — using the stub provider. ' +
        'Text layers are still extracted for real; only vision OCR and summaries are simulated. ' +
        'Set GROQ_API_KEY (or XAI_API_KEY) to enable them.',
    );
  }

  ocr(images: OcrImage[]): Promise<OcrResult> {
    return Promise.resolve({
      text: images
        .map((image) => `[stub OCR — page ${image.page}, ${image.data.length} bytes]`)
        .join('\n\n'),
      pages: images.length,
    });
  }

  /**
   * A real summary shape built from real text: the opening sentences, and the
   * most frequent long words as keywords. Enough for search indexing and the UI
   * to have something true to display, without pretending to be analysis.
   */
  summarise(text: string): Promise<SummaryResult> {
    const clean = text.replace(/\s+/g, ' ').trim();

    return Promise.resolve({
      summary: clean ? `[stub summary] ${clean.slice(0, 280)}` : undefined,
      keywords: topWords(clean, 5),
      language: looksArabic(clean) ? 'ar' : 'en',
      title: undefined,
    });
  }

  /**
   * Null, not a random vector. A fake embedding would populate the column with
   * numbers that rank nonsensically — worse than the honest empty state, which
   * simply leaves search on full text where it already works.
   */
  embed(): Promise<number[] | null> {
    return Promise.resolve(null);
  }
}

/** Crude frequency count. Good enough to produce stable, input-derived keywords. */
function topWords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();

  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 4) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Arabic block U+0600–U+06FF. Used only to pick a plausible stub language. */
function looksArabic(text: string): boolean {
  const arabic = text.match(/[؀-ۿ]/g)?.length ?? 0;
  return arabic > text.length * 0.2;
}
