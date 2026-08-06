import { Inject, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { AI_PROVIDER, type AiProvider, type OcrImage } from '../../ai/ai-provider.interface';

/**
 * Turns PDF pages into images a vision model can read.
 *
 * Only reached for a PDF with no usable text layer — a genuine scan. Anything
 * with embedded text is read directly by TextExtractorService, which is free,
 * instant and exact.
 *
 * WHY THIS EXISTS AT ALL: CLAUDE.md planned OCR around Anthropic, which accepts
 * a PDF as native document input. Neither vendor actually wired up does —
 * Groq's and xAI's vision endpoints accept images only. Rasterising is the
 * adapter between the format the product stores and the format the available
 * model can read.
 *
 * pdfjs is loaded through a dynamic import because its only build is ESM and
 * this package compiles to CommonJS. `module: nodenext` preserves the dynamic
 * import in the emitted JS rather than downlevelling it to require(), which is
 * what makes this work at runtime.
 */

/**
 * Render scale. PDF user-space is 72 dpi, so 2.0 gives 144 dpi — comfortably
 * enough for OCR on body text without producing images that have to be
 * aggressively recompressed to fit the upload limit.
 */
const RENDER_SCALE = 2;

/** Longest edge, in pixels. Bounds the cost of an A0 engineering drawing. */
const MAX_EDGE = 2200;

/**
 * Fraction of the provider's hard ceiling to aim for.
 *
 * The headroom covers base64's ~33% inflation, which applies to the encoded
 * payload rather than the raw bytes measured here — send something sized to the
 * limit exactly and it arrives a third over it.
 */
const SIZE_HEADROOM = 0.7;

@Injectable()
export class PdfRasterService {
  private readonly logger = new Logger(PdfRasterService.name);

  /**
   * The budget comes from the provider, not a constant.
   *
   * Vendors disagree — 10 MiB on xAI, 4 MB on Groq — and rendering to one
   * vendor's limit then sending to the other's is how a page silently gets
   * skipped for being oversized.
   */
  private readonly targetBytes: number;

  constructor(@Inject(AI_PROVIDER) ai: AiProvider) {
    this.targetBytes = Math.floor(ai.maxImageBytes * SIZE_HEADROOM);
  }

  /**
   * Renders up to `maxPages` pages.
   *
   * Returns fewer images than the document has pages when it is longer than the
   * cap. The caller records that as `ocrPages` so the UI can say the text is
   * partial — an index that looks complete but is not is worse than one that
   * admits its limits.
   */
  async rasterise(pdf: Buffer, maxPages: number): Promise<OcrImage[]> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    /**
     * The loading task is kept, not just its promise: `destroy()` lives on the
     * task, while the resolved PDFDocumentProxy only has `cleanup()`. Releasing
     * the document means calling the former.
     */
    const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
    const document = await task.promise;

    const { createCanvas } = await import('@napi-rs/canvas');
    const pageCount = Math.min(document.numPages, maxPages);
    const images: OcrImage[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const base = page.getViewport({ scale: RENDER_SCALE });

        // Scale back down if the page is enormous, keeping the aspect ratio.
        const longest = Math.max(base.width, base.height);
        const viewport =
          longest > MAX_EDGE
            ? page.getViewport({ scale: (RENDER_SCALE * MAX_EDGE) / longest })
            : base;

        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');

        /**
         * Paint the page white first. PDF pages have no background of their
         * own, and a transparent canvas encodes to black in a flattened image —
         * black-on-black scans OCR as an empty page.
         */
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        /**
         * Cast through unknown: pdfjs types its render target as the DOM
         * HTMLCanvasElement / CanvasRenderingContext2D, and @napi-rs/canvas is a
         * native Skia implementation of the same surface that does not claim
         * the DOM's event-target half. Structurally compatible for everything
         * pdfjs actually calls, which the rasterisation test exercises.
         */
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
        }).promise;
        page.cleanup();

        images.push({
          ...(await this.encode(await canvas.encode('png'), pageNumber)),
          page: pageNumber,
        });
      }
    } finally {
      // Frees the worker and its buffers; skipping it leaks per document.
      await task.destroy();
    }

    if (document.numPages > pageCount) {
      this.logger.warn(
        `Rasterised ${pageCount} of ${document.numPages} pages — capped by AI_MAX_OCR_PAGES`,
      );
    }

    return images;
  }

  /**
   * Keeps the PNG when it fits, falls back to JPEG when it does not.
   *
   * PNG is lossless and better for text, so it is the default. But a dense
   * colour scan can exceed the per-image limit, and a JPEG that the model can
   * actually read beats a PNG the API rejects.
   */
  private async encode(png: Buffer, page: number): Promise<{ data: Buffer; mimeType: string }> {
    if (png.length <= this.targetBytes) {
      return { data: png, mimeType: 'image/png' };
    }

    const jpeg = await sharp(png).jpeg({ quality: 82, mozjpeg: true }).toBuffer();

    this.logger.debug(
      `Page ${page}: PNG was ${png.length} bytes, re-encoded to JPEG at ${jpeg.length}`,
    );

    return { data: jpeg, mimeType: 'image/jpeg' };
  }
}
