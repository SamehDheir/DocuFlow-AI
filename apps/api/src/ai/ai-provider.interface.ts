/**
 * What the processing pipeline needs from a model vendor.
 *
 * Deliberately narrow. The pipeline asks for text out of pictures and a summary
 * out of text; it does not know about chat, tokens, roles or streaming. That
 * keeps the vendor swappable — CLAUDE.md originally specified Anthropic here and
 * the implementation is xAI, which is exactly the kind of change this boundary
 * exists to absorb.
 */

/** A page image on its way to a vision model. */
export interface OcrImage {
  /** Raw bytes. Encoded to base64 at the provider boundary, not before. */
  data: Buffer;
  /** `image/png` or `image/jpeg` — the only types xAI vision accepts. */
  mimeType: string;
  /** 1-based, used only to keep pages in order in the assembled text. */
  page: number;
}

export interface OcrResult {
  text: string;
  /** Pages actually read. Lower than the input when a limit truncated a scan. */
  pages: number;
}

/**
 * The structured half of AI analysis.
 *
 * Every field is optional because a model may legitimately have nothing useful
 * to say — an empty scan yields no keywords — and a missing field must degrade
 * rather than fail the document.
 */
export interface SummaryResult {
  summary?: string;
  keywords?: string[];
  /** BCP-47, as detected from the content rather than assumed from the tenant. */
  language?: string;
  /** A human title, when the filename is something like `scan_0042.pdf`. */
  title?: string;
}

export interface AiProvider {
  /** Identifies the provider in logs and in `DocumentMetadata.aiModel`. */
  readonly name: string;

  /** True when this provider can actually reach a model. */
  readonly available: boolean;

  /**
   * True when this provider has a model that accepts images.
   *
   * Not every vendor does, and it is not a detail the pipeline can shrug off:
   * rasterising a scan to page images is the expensive half of OCR, and doing
   * it for a provider that will reject the request wastes the work and then
   * fails anyway. The extractor checks this before it renders anything.
   */
  readonly supportsVision: boolean;

  /**
   * Largest single image this provider will accept, in raw bytes.
   *
   * Exposed because it varies by vendor — 10 MiB on xAI, 4 MB on Groq — and the
   * rasteriser has to downscale to fit BEFORE building a request. Reading it
   * from the provider keeps that decision with the vendor that imposes it,
   * rather than hardcoding one vendor's number into the PDF renderer.
   */
  readonly maxImageBytes: number;

  /**
   * Reads text out of page images.
   *
   * Only ever called for content with no extractable text layer — a real scan.
   * Anything with embedded text is parsed directly, which is both free and
   * exact where OCR is a guess.
   */
  ocr(images: OcrImage[]): Promise<OcrResult>;

  /** Summarises, and extracts keywords, language and a title in the same call. */
  summarise(text: string): Promise<SummaryResult>;

  /**
   * Embeddings, or null when the provider has none.
   *
   * Null is the expected answer for xAI, which publishes no embeddings
   * endpoint. Search falls back to Postgres full text, so this returning null
   * degrades ranking rather than breaking the feature.
   */
  embed(text: string): Promise<number[] | null>;
}

/** DI token. An interface cannot be one at runtime. */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
