const statsTracker = require('../../lib/stats-tracker');

describe('stats-tracker', () => {
  beforeEach(() => {
    statsTracker.clearState();
  });

  describe('updateFileState', () => {
    const makeStats = (overrides = {}) => ({
      totalCalls: 100,
      successfulCalls: 90,
      failedCalls: 10,
      currentCalls: 5,
      ...overrides
    });

    test('returns null on first call (no previous state)', () => {
      const result = statsTracker.updateFileState('/test/file.csv', makeStats(), 1000);
      expect(result).toBeNull();
    });

    test('returns deltas on second call with different fileSize', () => {
      // Mock Date.now to control time delta
      const realNow = Date.now;
      let time = realNow();
      Date.now = () => time;

      statsTracker.updateFileState('/test/file.csv', makeStats(), 1000);

      time += 5000; // 5 seconds later
      const result = statsTracker.updateFileState('/test/file.csv', makeStats({
        totalCalls: 150,
        successfulCalls: 130,
        failedCalls: 15
      }), 2000);

      Date.now = realNow;

      expect(result).not.toBeNull();
      expect(result.totalCallsDelta).toBe(50);
      expect(result.successfulCallsDelta).toBe(40);
      expect(result.failedCallsDelta).toBe(5);
      expect(result.timeDeltaSec).toBe(5);
      expect(result.instantCallRate).toBe(10); // 50 calls / 5 seconds
    });

    test('returns null when fileSize has not changed', () => {
      statsTracker.updateFileState('/test/file.csv', makeStats(), 1000);
      const result = statsTracker.updateFileState('/test/file.csv', makeStats({
        totalCalls: 200
      }), 1000);
      expect(result).toBeNull();
    });

    test('clamps negative deltas to zero', () => {
      statsTracker.updateFileState('/test/file.csv', makeStats({ totalCalls: 200 }), 1000);
      const result = statsTracker.updateFileState('/test/file.csv', makeStats({ totalCalls: 100 }), 2000);

      expect(result).not.toBeNull();
      expect(result.totalCallsDelta).toBe(0);
    });
  });

  describe('getFileState', () => {
    test('returns null for unknown file', () => {
      expect(statsTracker.getFileState('/nonexistent')).toBeNull();
    });

    test('returns state after updateFileState', () => {
      const stats = { totalCalls: 100, successfulCalls: 90, failedCalls: 10 };
      statsTracker.updateFileState('/test/file.csv', stats, 1000);
      const state = statsTracker.getFileState('/test/file.csv');
      expect(state).not.toBeNull();
      expect(state.lastStats).toEqual(stats);
      expect(state.lastFileSize).toBe(1000);
    });
  });

  describe('removeStaleFiles', () => {
    test('does not remove fresh files', () => {
      statsTracker.updateFileState('/test/fresh.csv', { totalCalls: 1 }, 100);
      const removed = statsTracker.removeStaleFiles();
      expect(removed).toHaveLength(0);
      expect(statsTracker.getFileState('/test/fresh.csv')).not.toBeNull();
    });

    test('removes files older than STALE_TIMEOUT_MS', () => {
      statsTracker.updateFileState('/test/old.csv', { totalCalls: 1 }, 100);

      // Mock Date.now to simulate time passage
      const realNow = Date.now;
      Date.now = () => realNow() + statsTracker.STALE_TIMEOUT_MS + 1000;

      const removed = statsTracker.removeStaleFiles();
      expect(removed).toContain('/test/old.csv');
      expect(statsTracker.getFileState('/test/old.csv')).toBeNull();

      Date.now = realNow;
    });
  });

  describe('aggregateStats', () => {
    test('returns empty map for empty input', () => {
      const result = statsTracker.aggregateStats([]);
      expect(result.size).toBe(0);
    });

    test('aggregates single file correctly', () => {
      const result = statsTracker.aggregateStats([{
        metadata: { serverId: 'srv1', scenario: 'register', transport: 'u1' },
        stats: {
          currentCalls: 5,
          totalCalls: 100,
          successfulCalls: 90,
          failedCalls: 10,
          failureBreakdown: { cannot_send_message: 1, max_udp_retrans: 2, unexpected_message: 0, call_rejected: 0, regexp_no_match: 0, regexp_hdr_not_found: 0, out_of_call: 0 }
        },
        deltas: null
      }]);

      expect(result.size).toBe(1);
      const agg = result.get('srv1:register:u1');
      expect(agg.currentCalls).toBe(5);
      expect(agg.totalCalls).toBe(100);
      expect(agg.failureBreakdown.cannot_send_message).toBe(1);
    });

    test('groups and sums files with same server/scenario/transport', () => {
      const result = statsTracker.aggregateStats([
        {
          metadata: { serverId: 'srv1', scenario: 'register', transport: 'u1' },
          stats: { currentCalls: 5, totalCalls: 100, successfulCalls: 90, failedCalls: 10, failureBreakdown: { cannot_send_message: 0, max_udp_retrans: 0, unexpected_message: 0, call_rejected: 0, regexp_no_match: 0, regexp_hdr_not_found: 0, out_of_call: 0 } },
          deltas: { totalCallsDelta: 10, timeDeltaSec: 5 }
        },
        {
          metadata: { serverId: 'srv1', scenario: 'register', transport: 'u1' },
          stats: { currentCalls: 3, totalCalls: 80, successfulCalls: 70, failedCalls: 5, failureBreakdown: { cannot_send_message: 0, max_udp_retrans: 0, unexpected_message: 0, call_rejected: 0, regexp_no_match: 0, regexp_hdr_not_found: 0, out_of_call: 0 } },
          deltas: { totalCallsDelta: 8, timeDeltaSec: 5 }
        }
      ]);

      expect(result.size).toBe(1);
      const agg = result.get('srv1:register:u1');
      expect(agg.currentCalls).toBe(8);
      expect(agg.totalCalls).toBe(180);
      expect(agg.successfulCalls).toBe(160);
      expect(agg.failedCalls).toBe(15);
      expect(agg.callRate).toBeCloseTo(1.8, 1); // 18 calls / 10 seconds
    });

    test('creates separate entries for different keys', () => {
      const result = statsTracker.aggregateStats([
        {
          metadata: { serverId: 'srv1', scenario: 'register', transport: 'u1' },
          stats: { currentCalls: 5, totalCalls: 100, successfulCalls: 90, failedCalls: 10, failureBreakdown: { cannot_send_message: 0, max_udp_retrans: 0, unexpected_message: 0, call_rejected: 0, regexp_no_match: 0, regexp_hdr_not_found: 0, out_of_call: 0 } },
          deltas: null
        },
        {
          metadata: { serverId: 'srv2', scenario: 'inbound', transport: 't1' },
          stats: { currentCalls: 3, totalCalls: 50, successfulCalls: 45, failedCalls: 5, failureBreakdown: { cannot_send_message: 0, max_udp_retrans: 0, unexpected_message: 0, call_rejected: 0, regexp_no_match: 0, regexp_hdr_not_found: 0, out_of_call: 0 } },
          deltas: null
        }
      ]);

      expect(result.size).toBe(2);
      expect(result.has('srv1:register:u1')).toBe(true);
      expect(result.has('srv2:inbound:t1')).toBe(true);
    });
  });

  describe('getCacheStats', () => {
    test('returns zeros when empty', () => {
      const stats = statsTracker.getCacheStats();
      expect(stats).toEqual({ totalFiles: 0, staleFiles: 0, activeFiles: 0 });
    });

    test('returns correct counts after adding files', () => {
      statsTracker.updateFileState('/test/a.csv', { totalCalls: 1 }, 100);
      statsTracker.updateFileState('/test/b.csv', { totalCalls: 2 }, 200);
      const stats = statsTracker.getCacheStats();
      expect(stats.totalFiles).toBe(2);
      expect(stats.activeFiles).toBe(2);
      expect(stats.staleFiles).toBe(0);
    });
  });

  describe('STALE_TIMEOUT_MS', () => {
    test('is exported and equals 5 minutes', () => {
      expect(statsTracker.STALE_TIMEOUT_MS).toBe(300000);
    });
  });
});
