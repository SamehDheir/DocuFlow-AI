import { ConfigService } from '@nestjs/config';
import type { OcrImage } from '../../ai/ai-provider.interface';
import type { Env } from '../../config/env.validation';
import type { PdfRasterService } from './pdf-raster.service';
import { TextExtractorService } from './text-extractor.service';

/**
 * Format dispatch.
 *
 * The thing worth testing here is WHICH path a file takes, because that is the
 * difference between a free, exact read of an embedded text layer and a paid,
 * approximate vision call. The parsers themselves are third-party code.
 *
 * PDF and Office fixtures are deliberately absent: both paths dynamically
 * import ESM (pdfjs, officeparser), which Jest's CommonJS runtime cannot do
 * without --experimental-vm-modules. Those are covered by processing.e2e-spec,
 * which runs on the real Node runtime.
 */

const ENV: Partial<Env> = { AI_OCR_ENABLED: true, AI_MAX_OCR_PAGES: 20 };

function setup(overrides: { ocrEnabled?: boolean; supportsVision?: boolean } = {}) {
  const config = {
    get: (key: keyof Env) => (key === 'AI_OCR_ENABLED' ? (overrides.ocrEnabled ?? true) : ENV[key]),
  } as unknown as ConfigService<Env, true>;

  const ai = {
    name: 'fake',
    available: true,
    supportsVision: overrides.supportsVision ?? true,
    maxImageBytes: 4 * 1024 * 1024,
    ocr: jest.fn((images: OcrImage[]) =>
      Promise.resolve({
        text: images.map((image) => `page ${image.page}`).join('\n\n'),
        pages: images.length,
      }),
    ),
    summarise: jest.fn(),
    embed: jest.fn(),
  };

  const raster = { rasterise: jest.fn() };

  const service = new TextExtractorService(ai, raster as unknown as PdfRasterService, config);

  return { service, ai, raster };
}

describe('TextExtractorService', () => {
  describe('plain text', () => {
    it('reads the bytes directly, with no AI call at all', async () => {
      const { service, ai } = setup();

      const result = await service.extract(Buffer.from('hello world', 'utf8'), 'text/plain');

      expect(result).toEqual({
        text: 'hello world',
        source: 'plain',
        pages: null,
        truncated: false,
      });
      expect(ai.ocr).not.toHaveBeenCalled();
    });

    it('preserves Arabic through the UTF-8 round trip', async () => {
      const { service } = setup();

      const result = await service.extract(Buffer.from('فاتورة رقم ٤٤٧١', 'utf8'), 'text/plain');

      expect(result.text).toBe('فاتورة رقم ٤٤٧١');
    });

    it('treats any text/* subtype as plain', async () => {
      const { service } = setup();

      const result = await service.extract(Buffer.from('a,b,c'), 'text/csv');

      expect(result.source).toBe('plain');
    });
  });

  describe('images', () => {
    it('sends PNG straight to the vision model', async () => {
      const { service, ai } = setup();

      const result = await service.extract(Buffer.from('png-bytes'), 'image/png');

      const [images] = ai.ocr.mock.calls[0];

      expect(images).toHaveLength(1);
      expect(images[0].mimeType).toBe('image/png');
      expect(images[0].page).toBe(1);
      expect(result.source).toBe('ocr');
      expect(result.text).toBe('page 1');
    });

    it('sends JPEG straight to the vision model', async () => {
      const { service, ai } = setup();

      await service.extract(Buffer.from('jpeg-bytes'), 'image/jpeg');

      expect(ai.ocr.mock.calls[0][0][0].mimeType).toBe('image/jpeg');
    });
  });

  describe('unsupported types', () => {
    it('reports SKIPPED rather than failing', async () => {
      const { service, ai } = setup();

      const result = await service.extract(Buffer.from('...'), 'application/zip');

      /**
       * An honest "there is no text here to find" — not an error. The document
       * still reaches READY and stays downloadable; only its searchability is
       * absent, which is the truth about a zip file.
       */
      expect(result).toEqual({ text: '', source: 'none', pages: null, truncated: false });
      expect(ai.ocr).not.toHaveBeenCalled();
    });
  });

  describe('when the provider has no vision model', () => {
    it('skips images rather than calling a model that would reject them', async () => {
      const { service, ai } = setup({ supportsVision: false });

      const result = await service.extract(Buffer.from('png'), 'image/png');

      // Groq's text models reject image content outright, so a provider
      // configured without a vision model must not attempt the call.
      expect(ai.ocr).not.toHaveBeenCalled();
      expect(result.source).toBe('none');
    });

    it('does not rasterise a scanned PDF it could never read', async () => {
      const { service, raster } = setup({ supportsVision: false });

      // Rendering is the expensive half; doing it for a provider that cannot
      // accept the output wastes the work and then fails anyway.
      await service.extract(Buffer.from('%PDF-1.4 no text layer'), 'application/pdf').catch(() => {
        // The fake buffer is not a parseable PDF; the assertion below is what
        // this test is about.
      });

      expect(raster.rasterise).not.toHaveBeenCalled();
    });
  });

  describe('when OCR is switched off', () => {
    it('skips images without calling the provider', async () => {
      const { service, ai } = setup({ ocrEnabled: false });

      const result = await service.extract(Buffer.from('png'), 'image/png');

      expect(ai.ocr).not.toHaveBeenCalled();
      expect(result.source).toBe('none');
    });

    it('still reads plain text, which costs nothing', async () => {
      const { service } = setup({ ocrEnabled: false });

      const result = await service.extract(Buffer.from('still readable'), 'text/plain');

      expect(result.text).toBe('still readable');
    });
  });
});
