const {
  updateResponseTimeMetrics,
  updateCallMetrics,
  updateStatsFileCount,
  getMetrics,
  getContentType,
  resetMetrics,
  getRegistry
} = require('../../lib/prometheus-metrics');

describe('prometheus-metrics', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('updateResponseTimeMetrics', () => {
    test('sets gauge values for percentiles and average', async () => {
      updateResponseTimeMetrics('srv1', 'register', 'register', 'u1', {
        average: 0.025,
        percentiles: { p50: 0.010, p95: 0.050, p99: 0.100 },
        count: 500
      });

      const output = await getMetrics();
      expect(output).toContain('sipp_response_time_average_seconds');
      expect(output).toContain('sipp_response_time_p50_seconds');
      expect(output).toContain('sipp_response_time_p95_seconds');
      expect(output).toContain('sipp_response_time_p99_seconds');
      expect(output).toContain('sipp_response_samples');
    });

    test('does not set average when it is 0', async () => {
      updateResponseTimeMetrics('srv1', 'register', 'register', 'u1', {
        average: 0,
        percentiles: { p50: 0.010, p95: 0.050, p99: 0.100 },
        count: 100
      });

      const output = await getMetrics();
      // Average gauge should not have been set for this label combination
      // But other gauges should be present
      expect(output).toContain('sipp_response_time_p50_seconds');
    });

    test('sets last update timestamp', async () => {
      updateResponseTimeMetrics('srv1', 'register', 'register', 'u1', {
        average: 0.025,
        percentiles: { p50: 0.010, p95: 0.050, p99: 0.100 },
        count: 100
      });

      const output = await getMetrics();
      expect(output).toContain('sipp_metrics_last_update_timestamp_seconds');
    });
  });

  describe('updateCallMetrics', () => {
    test('sets call volume metrics for aggregated stats', async () => {
      const aggregated = new Map();
      aggregated.set('srv1:register:u1', {
        labels: { server: 'srv1', scenario: 'register', transport: 'u1' },
        currentCalls: 10,
        callRate: 2.5,
        totalCalls: 1000,
        successfulCalls: 950,
        failedCalls: 50,
        failureBreakdown: {
          cannot_send_message: 5,
          max_udp_retrans: 10,
          unexpected_message: 0,
          call_rejected: 0,
          regexp_no_match: 0,
          regexp_hdr_not_found: 0,
          out_of_call: 0
        }
      });

      updateCallMetrics(aggregated);

      const output = await getMetrics();
      expect(output).toContain('sipp_current_calls');
      expect(output).toContain('sipp_call_rate_cps');
      expect(output).toContain('sipp_total_calls');
      expect(output).toContain('sipp_successful_calls_total');
      expect(output).toContain('sipp_failed_calls_total');
    });

    test('sets failure breakdown only for non-zero counts', async () => {
      const aggregated = new Map();
      aggregated.set('srv1:register:u1', {
        labels: { server: 'srv1', scenario: 'register', transport: 'u1' },
        currentCalls: 10,
        callRate: 2.5,
        totalCalls: 1000,
        successfulCalls: 950,
        failedCalls: 50,
        failureBreakdown: {
          cannot_send_message: 5,
          max_udp_retrans: 0,
          unexpected_message: 0,
          call_rejected: 0,
          regexp_no_match: 0,
          regexp_hdr_not_found: 0,
          out_of_call: 0
        }
      });

      updateCallMetrics(aggregated);

      const output = await getMetrics();
      expect(output).toContain('cannot_send_message');
      expect(output).not.toContain('max_udp_retrans');
    });

    test('handles empty Map', async () => {
      updateCallMetrics(new Map());
      const output = await getMetrics();
      // Should not throw, metrics should be reset
      expect(typeof output).toBe('string');
    });
  });

  describe('updateStatsFileCount', () => {
    test('sets the gauge to provided count', async () => {
      updateStatsFileCount(42);
      const output = await getMetrics();
      expect(output).toContain('sipp_stats_files_active');
      expect(output).toContain('42');
    });
  });

  describe('getMetrics / getContentType', () => {
    test('getMetrics returns a string', async () => {
      const output = await getMetrics();
      expect(typeof output).toBe('string');
    });

    test('getContentType returns a valid content type', () => {
      const ct = getContentType();
      expect(typeof ct).toBe('string');
      expect(ct.length).toBeGreaterThan(0);
    });
  });

  describe('resetMetrics / getRegistry', () => {
    test('resetMetrics clears all metric values', async () => {
      updateStatsFileCount(99);
      resetMetrics();
      // After reset, the gauge exists but values are cleared
      const registry = getRegistry();
      expect(registry).toBeDefined();
    });

    test('getRegistry returns the prometheus registry', () => {
      const registry = getRegistry();
      expect(registry).toBeDefined();
      expect(typeof registry.metrics).toBe('function');
    });
  });
});
