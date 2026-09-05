import { normalizePoolIdentityName, normalizePoolIdentityUrl } from '../../repositories/PoolIdentityStatsRepository';

describe('PoolIdentityStatsRepository normalization', () => {
  describe('normalizePoolIdentityName', () => {
    it('returns null for undefined, null, and empty input', () => {
      expect(normalizePoolIdentityName(undefined)).toBeNull();
      expect(normalizePoolIdentityName(null)).toBeNull();
      expect(normalizePoolIdentityName('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(normalizePoolIdentityName('   ')).toBeNull();
    });

    it('trims surrounding whitespace', () => {
      expect(normalizePoolIdentityName('  MeinPool  ')).toBe('MeinPool');
    });

    it('truncates to the InnoDB utf8mb4 primary-key-safe length (191)', () => {
      const long = 'x'.repeat(300);
      const result = normalizePoolIdentityName(long);
      expect(result).not.toBeNull();
      expect(result?.length).toBe(191);
    });

    it('leaves a name at or under the limit untouched', () => {
      const exact = 'y'.repeat(191);
      expect(normalizePoolIdentityName(exact)).toBe(exact);
    });
  });

  describe('normalizePoolIdentityUrl', () => {
    it('returns null for undefined, null, and empty input', () => {
      expect(normalizePoolIdentityUrl(undefined)).toBeNull();
      expect(normalizePoolIdentityUrl(null)).toBeNull();
      expect(normalizePoolIdentityUrl('')).toBeNull();
    });

    it('trims surrounding whitespace', () => {
      expect(normalizePoolIdentityUrl('  https://example.com  ')).toBe('https://example.com');
    });

    it('truncates to 255 characters', () => {
      const long = 'https://example.com/' + 'x'.repeat(300);
      const result = normalizePoolIdentityUrl(long);
      expect(result).not.toBeNull();
      expect(result?.length).toBe(255);
    });
  });
});
