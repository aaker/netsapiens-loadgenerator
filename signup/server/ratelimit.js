// Fixed-window rate limiter: per-IP hourly + global daily. In-memory,
// single-process (matches the app's single-instance deployment model).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function createRateLimiter(options) {
  const perHour = options.perHour;
  const globalPerDay = options.globalPerDay;
  const ipHits = new Map(); // ip -> [timestamps]
  let globalHits = [];

  setInterval(() => {
    const cutoff = Date.now() - HOUR_MS;
    for (const [ip, hits] of ipHits) {
      const kept = hits.filter(t => t > cutoff);
      if (kept.length === 0) ipHits.delete(ip);
      else ipHits.set(ip, kept);
    }
  }, 10 * 60 * 1000).unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    globalHits = globalHits.filter(t => t > now - DAY_MS);
    if (globalHits.length >= globalPerDay) {
      const retryAfterSeconds = Math.ceil((globalHits[0] + DAY_MS - now) / 1000);
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Signup capacity for today has been reached. Please try again tomorrow.', retryAfterSeconds } });
    }

    const hits = (ipHits.get(ip) || []).filter(t => t > now - HOUR_MS);
    if (hits.length >= perHour) {
      const retryAfterSeconds = Math.ceil((hits[0] + HOUR_MS - now) / 1000);
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many signup attempts. Please try again later.', retryAfterSeconds } });
    }

    hits.push(now);
    ipHits.set(ip, hits);
    globalHits.push(now);
    next();
  };
}

module.exports = { createRateLimiter };
