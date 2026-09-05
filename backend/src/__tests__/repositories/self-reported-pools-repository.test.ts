import { normalizeSelfReportedName, normalizeSelfReportedUrl, slugifySelfReportedName } from '../../repositories/SelfReportedPoolsRepository';

describe('SelfReportedPoolsRepository normalization', () => {
  describe('normalizeSelfReportedName', () => {
    it('returns null for undefined, null, and empty input', () => {
      expect(normalizeSelfReportedName(undefined)).toBeNull();
      expect(normalizeSelfReportedName(null)).toBeNull();
      expect(normalizeSelfReportedName('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(normalizeSelfReportedName('   ')).toBeNull();
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeSelfReportedName('  MeinPool  ')).toBe('MeinPool');
    });

    it('truncates to the pools.name column width (50)', () => {
      const long = 'x'.repeat(80);
      const result = normalizeSelfReportedName(long);
      expect(result).not.toBeNull();
      expect(result?.length).toBe(50);
    });

    it('leaves a name at or under the limit untouched', () => {
      const exact = 'y'.repeat(50);
      expect(normalizeSelfReportedName(exact)).toBe(exact);
    });
  });

  describe('normalizeSelfReportedUrl', () => {
    it('returns an empty string for undefined, null, and empty input', () => {
      expect(normalizeSelfReportedUrl(undefined)).toBe('');
      expect(normalizeSelfReportedUrl(null)).toBe('');
      expect(normalizeSelfReportedUrl('')).toBe('');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeSelfReportedUrl('  https://example.com  ')).toBe('https://example.com');
    });

    it('truncates to the pools.link column width (255)', () => {
      const long = 'https://example.com/' + 'x'.repeat(300);
      const result = normalizeSelfReportedUrl(long);
      expect(result.length).toBe(255);
    });
  });

  describe('slugifySelfReportedName', () => {
    it('strips non-alphanumeric characters and lowercases', () => {
      expect(slugifySelfReportedName('Mein Pool! #1')).toBe('meinpool1');
    });

    it('falls back to "pool" when nothing alphanumeric remains', () => {
      expect(slugifySelfReportedName('!!!')).toBe('pool');
    });

    it('truncates to the pools.slug column width (50)', () => {
      const long = 'a'.repeat(80);
      expect(slugifySelfReportedName(long).length).toBe(50);
    });
  });
});
