import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { AI_PROVIDER, type AiProvider, type OcrImage } from '../../ai/ai-provider.interface';
import type { Env } from '../../config/env.validation';
import { PdfRasterService } from './pdf-raster.service';

/**
 * Gets plain text out of an uploaded file, whatever it is.
 *
 * The dispatch order below is the whole design. Every path that can avoid a
 * vision call does, because an embedded text layer is free, instant and
 * character-exact, where OCR costs money per page and is a best guess. OCR is
 * the fallback for the one case that genuinely needs it — a scan.
 *
 *   text/plain          → read the bytes
 *   PDF with text       → parse the text layer
 *   PDF without text    → rasterise → vision OCR      ← the only paid path for PDFs
 *   docx / pptx / xlsx  → parse the document XML
 *   png / jpeg          → vision OCR
 *   tiff                → convert to PNG → vision OCR
 *   anything else       → SKIPPED
 */

export type ExtractionSource = 'plain' | 'text-layer' | 'office' | 'ocr' | 'none';

export interface ExtractionResult {
  text: string;
  /** How the text was obtained — surfaced so a stub OCR is never mistaken for a real one. */
  source: ExtractionSource;
  /** Pages read. Null when the concept does not apply (a spreadsheet, a text file). */
  pages: number | null;
  /** True when a page cap stopped this short of the whole document. */
  truncated: boolean;
  /** Metadata the parser found on the way, used when the user set none. */
  title?: string;
  author?: string;
}

const PDF = 'application/pdf';
const PLAIN = 'text/plain';

/** Formats officeparser handles from their own markup. */
const OFFICE_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

/** Sent to the vision model as-is. */
const DIRECT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

/** Readable by sharp, but not accepted by the vision API — converted first. */
const CONVERTIBLE_IMAGE_TYPES = new Set(['image/tiff', 'image/gif', 'image/webp']);

/**
 * Below this many characters per page, a PDF is treated as scanned.
 *
 * Not zero, deliberately. A scan run through a "searchable PDF" tool often
 * carries a few stray characters — a page number, a stamp, a header — which
 * would pass an `if (text)` check and leave the real content unread. A page
 * with genuine text has far more than this.
 */
const MIN_CHARS_PER_PAGE = 24;

@Injectable()
export class TextExtractorService {
  private readonly logger = new Logger(TextExtractorService.name);
  private readonly ocrEnabled: boolean;
  private readonly maxPages: number;

  constructor(
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly raster: PdfRasterService,
    config: ConfigService<Env, true>,
  ) {
    this.ocrEnabled = config.get('AI_OCR_ENABLED', { infer: true });
    this.maxPages = config.get('AI_MAX_OCR_PAGES', { infer: true });
  }

  async extract(file: Buffer, mimeType: string): Promise<ExtractionResult> {
    const type = mimeType.toLowerCase();

    if (type === PLAIN || type.startsWith('text/')) {
      return { text: file.toString('utf8'), source: 'plain', pages: null, truncated: false };
    }

    if (type === PDF) {
      return this.fromPdf(file);
    }

    if (OFFICE_TYPES.has(type)) {
      return this.fromOffice(file, type);
    }

    if (DIRECT_IMAGE_TYPES.has(type)) {
      return this.fromImages([{ data: file, mimeType: type, page: 1 }]);
    }

    if (CONVERTIBLE_IMAGE_TYPES.has(type)) {
      const png = await sharp(file).png().toBuffer();
      return this.fromImages([{ data: png, mimeType: 'image/png', page: 1 }]);
    }

    // Not a failure — an honest "there is no text here to find".
    return { text: '', source: 'none', pages: null, truncated: false };
  }

  /**
   * Text layer first, rasterise only if there isn't one.
   *
   * The same pdfjs parse yields the page count and the document metadata, so
   * the decision costs one read either way.
   */
  private async fromPdf(file: Buffer): Promise<ExtractionResult> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // The loading task owns destroy(); the resolved proxy only has cleanup().
    const task = pdfjs.getDocument({ data: new Uint8Array(file), useSystemFonts: true });
    const document = await task.promise;

    let text = '';
    let info: { Title?: string; Author?: string } = {};
    // Captured inside the try: everything below runs after the task is
    // destroyed, and reading off a released document is not something to rely on.
    let pageCount = 0;

    try {
      info = (await document.getMetadata().catch(() => undefined))?.info ?? {};
      pageCount = document.numPages;

      const pages: string[] = [];

      for (let page = 1; page <= pageCount; page += 1) {
        const loaded = await document.getPage(page);
        const content = await loaded.getTextContent();

        pages.push(
          content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
            .trim(),
        );

        loaded.cleanup();
      }

      text = pages.filter(Boolean).join('\n\n');
    } finally {
      await task.destroy();
    }

    const hasTextLayer = text.trim().length >= MIN_CHARS_PER_PAGE * Math.min(pageCount, 4);

    if (hasTextLayer) {
      return {
        text,
        source: 'text-layer',
        pages: pageCount,
        truncated: false,
        title: info.Title || undefined,
        author: info.Author || undefined,
      };
    }

    this.logger.debug(
      `PDF has no usable text layer across ${pageCount} pages; rasterising for OCR`,
    );

    const result = await this.fromImages(await this.rasterisePages(file));

    return {
      ...result,
      truncated: pageCount > this.maxPages,
      title: info.Title || undefined,
      author: info.Author || undefined,
    };
  }

  private async rasterisePages(file: Buffer): Promise<OcrImage[]> {
    // Skip the render entirely when there is nothing to send the images to —
    // rendering is the expensive half, and a provider with no vision model
    // would reject the request after the work was already done.
    return this.canOcr() ? this.raster.rasterise(file, this.maxPages) : [];
  }

  /** Both switches: OCR turned off by configuration, or a provider without vision. */
  private canOcr(): boolean {
    return this.ocrEnabled && this.ai.supportsVision;
  }

  private async fromOffice(file: Buffer, mimeType: string): Promise<ExtractionResult> {
    const { parseOffice } = await import('officeparser');

    try {
      const ast = await parseOffice(file, {
        /**
         * officeparser can run its own OCR over embedded images. Left off: this
         * pipeline has one OCR provider, and a second engine with different
         * quality and no cost accounting would make results unattributable.
         */
        ocr: false,
        extractAttachments: false,
      });

      return {
        text: ast.toText().trim(),
        source: 'office',
        pages: ast.metadata.pages ?? null,
        truncated: false,
        title: ast.metadata.title || undefined,
        author: ast.metadata.author || undefined,
      };
    } catch (error) {
      // A corrupt or password-protected file is the document's problem, not a
      // pipeline failure. Report it so the row records a reason.
      throw new Error(`Could not read ${mimeType}: ${(error as Error).message}`);
    }
  }

  private async fromImages(images: OcrImage[]): Promise<ExtractionResult> {
    if (!this.canOcr() || images.length === 0) {
      return { text: '', source: 'none', pages: null, truncated: false };
    }

    const result = await this.ai.ocr(images);

    return { text: result.text, source: 'ocr', pages: result.pages, truncated: false };
  }
}
