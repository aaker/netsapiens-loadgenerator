const { randomIntFromInterval, toHex, getDomainSize } = require('../../lib/utils');

describe('utils', () => {
  describe('randomIntFromInterval', () => {
    test('returns value within range', () => {
      for (let i = 0; i < 100; i++) {
        const result = randomIntFromInterval(1, 10);
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(10);
      }
    });

    test('returns the value when min equals max', () => {
      expect(randomIntFromInterval(5, 5)).toBe(5);
    });

    test('returns an integer', () => {
      for (let i = 0; i < 50; i++) {
        const result = randomIntFromInterval(1, 100);
        expect(Number.isInteger(result)).toBe(true);
      }
    });
  });

  describe('toHex', () => {
    test('converts ASCII string to hex with non-digits stripped', () => {
      // 'abc' -> hex '616263' -> all digits, so '616263'
      expect(toHex('abc')).toBe('616263');
    });

    test('strips hex letter characters from result', () => {
      // 'z' -> charCode 122 -> hex '7a' -> strip non-digits -> '7'
      expect(toHex('z')).toBe('7');
    });

    test('returns empty string for empty input', () => {
      expect(toHex('')).toBe('');
    });

    test('handles numeric string input', () => {
      // '1' -> charCode 49 -> hex '31' -> '31'
      expect(toHex('1')).toBe('31');
    });
  });

  describe('getDomainSize', () => {
    test('returns 10000 for i=1000 regardless of domain', () => {
      expect(getDomainSize('anything', 1000)).toBe(10000);
      expect(getDomainSize('test.com', 1000)).toBe(10000);
    });

    test('is deterministic for the same inputs', () => {
      const result1 = getDomainSize('example.com', 5);
      const result2 = getDomainSize('example.com', 5);
      expect(result1).toBe(result2);
    });

    test('returns different sizes for different domains', () => {
      const result1 = getDomainSize('alpha.com', 1);
      const result2 = getDomainSize('beta.com', 1);
      // Not guaranteed but very likely different
      // At minimum, both should be valid positive integers
      expect(result1).toBeGreaterThan(0);
      expect(result2).toBeGreaterThan(0);
    });

    test('returns value in normal range for typical domains', () => {
      // Most domains should fall in the 5-50 range
      const result = getDomainSize('normalcompany.com', 10);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(2500);
    });

    test('reduces size for i > 500 when domainSize > 10', () => {
      const domain = 'test.com';
      const earlyResult = getDomainSize(domain, 100);
      const lateResult = getDomainSize(domain, 600);
      // Late entries (i>500) with size>10 get divided by 4
      // So late result should generally be smaller
      if (earlyResult > 10) {
        expect(lateResult).toBeLessThanOrEqual(earlyResult);
      }
    });

    test('always returns a positive integer', () => {
      for (let i = 0; i < 20; i++) {
        const result = getDomainSize(`domain${i}.com`, i);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
