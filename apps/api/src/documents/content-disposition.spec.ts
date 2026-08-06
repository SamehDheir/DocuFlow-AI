import { contentDisposition } from './content-disposition';

describe('contentDisposition', () => {
  it('marks a download as an attachment and a preview as inline', () => {
    expect(contentDisposition('report.pdf', false)).toMatch(/^attachment;/);
    expect(contentDisposition('report.pdf', true)).toMatch(/^inline;/);
  });

  it('passes an ASCII filename through in both forms', () => {
    expect(contentDisposition('report.pdf', false)).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('carries an Arabic filename in the RFC 5987 parameter', () => {
    // The product ships in Arabic, so this is the normal case rather than the
    // exotic one — a raw non-ASCII byte in the quoted form is not a valid
    // header and browsers mangle it.
    const header = contentDisposition('تقرير.pdf', false);

    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent('تقرير'));
    // The fallback must stay ASCII-only, or it defeats its own purpose.
    expect(header.match(/filename="([^"]*)"/)?.[1]).toMatch(/^[\x20-\x7e]*$/);
  });

  it('never lets a quote escape the fallback parameter', () => {
    // An unescaped quote would close `filename="` early and let the rest of the
    // name be read as further header parameters.
    const header = contentDisposition('evil".pdf', false);

    expect(header.match(/filename="([^"]*)"/)?.[1]).toBe('evil_.pdf');
  });

  it('strips control characters rather than emitting them raw', () => {
    const header = contentDisposition('a\r\nb.pdf', false);

    expect(header).not.toMatch(/[\r\n]/);
  });

  it('keeps a placeholder per character when nothing ASCII survives', () => {
    // One underscore per character, so the fallback still hints at the original
    // length rather than collapsing to a single token.
    expect(contentDisposition('تقرير', false)).toContain('filename="_____"');
  });

  it('never emits an empty fallback filename', () => {
    expect(contentDisposition('', false)).toContain('filename="download"');
  });
});
