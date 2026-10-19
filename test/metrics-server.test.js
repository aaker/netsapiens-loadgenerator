const request = require('supertest');
const { app } = require('../metrics-server');

describe('metrics-server HTTP endpoints', () => {
  describe('GET /', () => {
    test('returns 200 with HTML containing title', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('SIPp Prometheus Metrics Server');
    });
  });

  describe('GET /health', () => {
    test('returns 200 with JSON status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('activeFiles');
      expect(res.body).toHaveProperty('settings');
      expect(res.body.settings).toHaveProperty('updateIntervalSec');
    });
  });

  describe('GET /metrics', () => {
    test('returns 200 with prometheus content type', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain|application\/openmetrics/);
    });

    test('response contains expected metric names', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('sipp_stats_files_active');
    });
  });
});
