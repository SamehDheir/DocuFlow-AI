import { buildStorageKey, extensionOf } from './storage-key';

const COMPANY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('buildStorageKey', () => {
  it('lays the key out as documents/company_<id>/<year>/<month>/<uuid>.<ext>', () => {
    const key = buildStorageKey(COMPANY, 'pdf', new Date(Date.UTC(2026, 7, 4)));

    expect(key).toMatch(new RegExp(`^documents/company_${COMPANY}/2026/08/[0-9a-f-]{36}\\.pdf$`));
  });

  it('zero-pads the month', () => {
    const key = buildStorageKey(COMPANY, 'png', new Date(Date.UTC(2026, 0, 31)));

    expect(key).toContain('/2026/01/');
  });

  it('never repeats a key for the same company, date and extension', () => {
    const at = new Date(Date.UTC(2026, 7, 4));

    expect(buildStorageKey(COMPANY, 'pdf', at)).not.toEqual(buildStorageKey(COMPANY, 'pdf', at));
  });

  it('refuses a company id that is not a uuid', () => {
    // The company always comes from the JWT, so this is defence in depth — but
    // a key is a path, and "../.." must never be able to reach this far.
    expect(() => buildStorageKey('../../etc', 'pdf')).toThrow(/non-uuid company id/);
  });
});

describe('extensionOf', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['REPORT.PDF', 'pdf'],
    ['archive.tar.gz', 'gz'],
    ['photo.jpeg', 'jpeg'],
  ])('reads %s as .%s', (filename, expected) => {
    expect(extensionOf(filename)).toBe(expected);
  });

  it.each([
    ['no-extension', 'bin'],
    ['trailing.', 'bin'],
    ['', 'bin'],
  ])('falls back to .bin for %s', (filename, expected) => {
    expect(extensionOf(filename)).toBe(expected);
  });

  it('strips separators so an extension can never traverse', () => {
    // A crafted name must not be able to steer the object key.
    expect(extensionOf('invoice.pdf/../../secret')).toBe('secret');
    expect(extensionOf('x.p/d\\f')).toBe('pdf');
  });

  it('takes the last segment of a double extension', () => {
    expect(extensionOf('payload.pdf.exe')).toBe('exe');
  });
});
