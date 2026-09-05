import { EnvValidationError, parseBoolean, parseEnum, parseInteger, parseList } from './env.parsers';

describe('env parsers', () => {
  describe('parseBoolean', () => {
    it.each(['true', 'TRUE', ' True ', '1', 'yes', 'on'])('reads %p as true', raw => {
      expect(parseBoolean('FLAG', raw, false)).toBe(true);
    });

    it.each(['false', 'FALSE', ' false ', '0', 'no', 'off'])('reads %p as false', raw => {
      expect(parseBoolean('FLAG', raw, true)).toBe(false);
    });

    it.each([undefined, '', '   '])('falls back to the default for %p', raw => {
      expect(parseBoolean('FLAG', raw, true)).toBe(true);
      expect(parseBoolean('FLAG', raw, false)).toBe(false);
    });

    it('throws on a value that is neither, naming the variable', () => {
      expect(() => parseBoolean('IGNORE_GROUPS', 'si', false)).toThrow(EnvValidationError);
      expect(() => parseBoolean('IGNORE_GROUPS', 'si', false)).toThrow(/IGNORE_GROUPS/);
    });
  });

  describe('parseInteger', () => {
    it('parses a plain integer', () => {
      expect(parseInteger('SIZE', '5242880', 0)).toBe(5242880);
    });

    it.each([undefined, '', '  '])('falls back to the default for %p', raw => {
      expect(parseInteger('SIZE', raw, 16777216)).toBe(16777216);
    });

    // The whole point of the parser: parseInt would read these as 16 and 5,
    // silently installing a limit nobody chose.
    it.each(['16MB', '5.9', '1e6', 'abc', '5 5'])('rejects %p instead of truncating it', raw => {
      expect(() => parseInteger('MEDIA_MAX_BYTES', raw, 0)).toThrow(EnvValidationError);
    });

    it('enforces the minimum', () => {
      expect(() => parseInteger('MEDIA_DOWNLOAD_CONCURRENCY', '0', 1, { min: 1 })).toThrow(/must be >= 1/);
      expect(parseInteger('MEDIA_DOWNLOAD_CONCURRENCY', '1', 1, { min: 1 })).toBe(1);
    });

    it('enforces the maximum', () => {
      expect(() => parseInteger('WORKERS', '11', 1, { max: 10 })).toThrow(/must be <= 10/);
    });

    it('allows 0 where 0 is meaningful', () => {
      expect(parseInteger('MEDIA_MAX_BYTES', '0', 16777216, { min: 0 })).toBe(0);
    });
  });

  describe('parseEnum', () => {
    const allowed = ['skip', 'download'] as const;

    it('matches case-insensitively', () => {
      expect(parseEnum('POLICY', 'SKIP', allowed, 'download')).toBe('skip');
      expect(parseEnum('POLICY', ' download ', allowed, 'skip')).toBe('download');
    });

    it('falls back to the default when unset', () => {
      expect(parseEnum('POLICY', undefined, allowed, 'skip')).toBe('skip');
    });

    it('lists the accepted values when it throws', () => {
      expect(() => parseEnum('MEDIA_UNKNOWN_SIZE_POLICY', 'maybe', allowed, 'skip')).toThrow(/skip, download/);
    });
  });

  describe('parseList', () => {
    it('trims, lowercases, drops empties and de-duplicates', () => {
      expect(parseList('TYPES', ' Image, ,document,IMAGE,')).toEqual(['image', 'document']);
    });

    it.each([undefined, '', ' , , '])('returns an empty list for %p', raw => {
      expect(parseList('TYPES', raw)).toEqual([]);
    });

    it('rejects entries outside the allowed set', () => {
      expect(() => parseList('MEDIA_ALLOWED_TYPES', 'image,imgae', ['image', 'document'])).toThrow(/imgae/);
    });

    it('accepts entries inside the allowed set', () => {
      expect(parseList('MEDIA_ALLOWED_TYPES', 'image,document', ['image', 'document', 'video'])).toEqual([
        'image',
        'document',
      ]);
    });
  });
});
