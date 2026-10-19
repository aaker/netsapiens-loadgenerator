const { timeZones, queueNames, departmentNames, phoneModels } = require('../../lib/randomdata');

describe('randomdata', () => {
  describe('timeZones', () => {
    test('has 7 entries', () => {
      expect(timeZones).toHaveLength(7);
    });

    test('all start with "US/"', () => {
      timeZones.forEach(tz => {
        expect(tz).toMatch(/^US\//);
      });
    });

    test('has no duplicates', () => {
      expect(new Set(timeZones).size).toBe(timeZones.length);
    });
  });

  describe('queueNames', () => {
    test('is a non-empty array of strings', () => {
      expect(queueNames.length).toBeGreaterThan(0);
      queueNames.forEach(name => {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      });
    });
  });

  describe('departmentNames', () => {
    test('is a non-empty array of strings', () => {
      expect(departmentNames.length).toBeGreaterThan(0);
      departmentNames.forEach(name => {
        expect(typeof name).toBe('string');
      });
    });

    test('has no duplicates', () => {
      expect(new Set(departmentNames).size).toBe(departmentNames.length);
    });
  });

  describe('phoneModels', () => {
    test('is a non-empty array of strings', () => {
      expect(phoneModels.length).toBeGreaterThan(0);
      phoneModels.forEach(model => {
        expect(typeof model).toBe('string');
      });
    });

    test('has no duplicates', () => {
      expect(new Set(phoneModels).size).toBe(phoneModels.length);
    });
  });
});
