const { parseStatsFilename, extractResponseTimes } = require('../../lib/sipp-parser');

describe('sipp-parser', () => {
  describe('parseStatsFilename', () => {
    test('parses full format with server ID', () => {
      const result = parseStatsFilename('prod1_register_t1_example_com_12345.csv');
      expect(result).toEqual({
        serverId: 'prod1',
        scenario: 'register',
        transport: 't1',
        deviceFile: 'example_com',
        pid: '12345'
      });
    });

    test('parses inbound scenario', () => {
      const result = parseStatsFilename('prod1_inbound_u1_US_Eastern_12346.csv');
      expect(result).toEqual({
        serverId: 'prod1',
        scenario: 'inbound',
        transport: 'u1',
        deviceFile: 'US_Eastern',
        pid: '12346'
      });
    });

    test('parses format without server ID (defaults to "default")', () => {
      const result = parseStatsFilename('register_l1_example_com_12347.csv');
      expect(result).toEqual({
        serverId: 'default',
        scenario: 'register',
        transport: 'l1',
        deviceFile: 'example_com',
        pid: '12347'
      });
    });

    test('handles all transport types', () => {
      expect(parseStatsFilename('srv_register_u1_dom_1.csv').transport).toBe('u1');
      expect(parseStatsFilename('srv_register_t1_dom_1.csv').transport).toBe('t1');
      expect(parseStatsFilename('srv_register_l1_dom_1.csv').transport).toBe('l1');
    });

    test('returns unknown for unrecognized format', () => {
      const result = parseStatsFilename('random_file.csv');
      expect(result.serverId).toBe('unknown');
      expect(result.scenario).toBe('unknown');
      expect(result.transport).toBe('unknown');
      expect(result.pid).toBe('0');
    });

    test('strips .csv extension', () => {
      const result = parseStatsFilename('prod1_register_u1_test_99.csv');
      expect(result.pid).toBe('99');
    });

    test('handles path with directory', () => {
      const result = parseStatsFilename('/var/stats/prod1_register_u1_test_99.csv');
      expect(result.serverId).toBe('prod1');
      expect(result.scenario).toBe('register');
    });
  });

  describe('extractResponseTimes', () => {
    test('returns empty object for record with no ResponseTimeRepartition keys', () => {
      const record = { CurrentTime: '12345', ElapsedTime: '100' };
      expect(extractResponseTimes(record)).toEqual({});
    });

    test('extracts single operation response times', () => {
      const record = {
        'ResponseTimeRepartitionregister_<10': '50',
        'ResponseTimeRepartitionregister_<20': '30',
        'ResponseTimeRepartitionregister_>=20': '5'
      };
      const result = extractResponseTimes(record);
      expect(result).toHaveProperty('register');
      expect(result.register.count).toBe(85);
      expect(result.register.percentiles).toBeDefined();
      expect(result.register.percentiles.p50).toBeDefined();
      expect(result.register.percentiles.p95).toBeDefined();
      expect(result.register.percentiles.p99).toBeDefined();
      expect(result.register.average).toBeGreaterThan(0);
    });

    test('extracts multiple operations independently', () => {
      const record = {
        'ResponseTimeRepartitionregister_<10': '100',
        'ResponseTimeRepartitionreregister_<20': '50',
        'ResponseTimeRepartitionreregister_>=20': '10'
      };
      const result = extractResponseTimes(record);
      expect(Object.keys(result)).toHaveLength(2);
      expect(result).toHaveProperty('register');
      expect(result).toHaveProperty('reregister');
    });

    test('normalizes numeric operation names', () => {
      const record = {
        'ResponseTimeRepartition1_<100': '10',
        'ResponseTimeRepartition2_<100': '20',
        'ResponseTimeRepartition3_<100': '30'
      };
      const result = extractResponseTimes(record);
      expect(result).toHaveProperty('invite');
      expect(result).toHaveProperty('subscribe');
      expect(result).toHaveProperty('notify');
    });

    test('skips operations with zero-count buckets only', () => {
      const record = {
        'ResponseTimeRepartitionregister_<10': '0',
        'ResponseTimeRepartitionregister_<20': '0'
      };
      const result = extractResponseTimes(record);
      expect(result).toEqual({});
    });

    test('calculates correct percentiles for known distribution', () => {
      // 100 samples all in the <10 bucket -> p50/p95/p99 all = midpoint of [0,10) = 5ms -> 0.005s
      const record = {
        'ResponseTimeRepartitionregister_<10': '100'
      };
      const result = extractResponseTimes(record);
      expect(result.register.percentiles.p50).toBeCloseTo(0.005, 3);
      expect(result.register.percentiles.p95).toBeCloseTo(0.005, 3);
      expect(result.register.percentiles.p99).toBeCloseTo(0.005, 3);
    });

    test('calculates average in seconds', () => {
      // All 100 in <10ms bucket -> midpoint 5ms -> avg = 5ms = 0.005s
      const record = {
        'ResponseTimeRepartitionregister_<10': '100'
      };
      const result = extractResponseTimes(record);
      expect(result.register.average).toBeCloseTo(0.005, 3);
    });

    test('handles >= bucket with estimated midpoint', () => {
      const record = {
        'ResponseTimeRepartitionregister_>=100': '10'
      };
      const result = extractResponseTimes(record);
      expect(result.register.count).toBe(10);
      // >= 100 bucket uses estimate of threshold * 1.5 = 150ms -> 0.15s
      expect(result.register.average).toBeCloseTo(0.15, 2);
    });
  });
});
