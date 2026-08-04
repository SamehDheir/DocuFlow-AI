import { durationToMs } from './duration';

describe('durationToMs', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ])('parses %s', (input, expected) => {
    expect(durationToMs(input)).toBe(expected);
  });

  it('accepts the casing and spacing people actually write', () => {
    expect(durationToMs(' 7D ')).toBe(604_800_000);
  });

  it.each(['', '7', 'd', '7 weeks', '1.5h', '-3d', '7dd'])(
    'rejects %p rather than guessing',
    (input) => {
      // A silently-misread TTL is the kind of thing that ships a session
      // lasting minutes instead of days, or the reverse.
      expect(() => durationToMs(input)).toThrow(/Unsupported duration/);
    },
  );
});
