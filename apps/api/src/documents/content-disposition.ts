/**
 * Builds a Content-Disposition header that survives non-ASCII filenames.
 *
 * This product ships in Arabic, so "report.pdf" is the easy case and
 * "تقرير.pdf" is the normal one. A raw non-ASCII filename in the quoted form is
 * not valid in an HTTP header and browsers mangle it, so RFC 5987's
 * `filename*=UTF-8''…` carries the real name and the quoted `filename=` is left
 * as an ASCII-only fallback for anything that does not understand it.
 *
 * Quotes, backslashes and control characters are stripped from the fallback —
 * an unescaped quote would end the parameter early and let a crafted filename
 * inject header parameters.
 */
export function contentDisposition(filename: string, inline: boolean): string {
  const type = inline ? 'inline' : 'attachment';
  const fallback = toAsciiFallback(filename);
  const encoded = encodeRFC5987(filename);

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function toAsciiFallback(filename: string): string {
  const stripped = filename
    // Non-printable and non-ASCII become underscores rather than vanishing, so
    // the fallback still hints at the original length and shape.
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();

  return stripped || 'download';
}

function encodeRFC5987(value: string): string {
  return (
    encodeURIComponent(value)
      // encodeURIComponent leaves these, but RFC 5987's attr-char set excludes
      // them, so they are percent-encoded by hand.
      .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%(7C|60|5E)/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  );
}
