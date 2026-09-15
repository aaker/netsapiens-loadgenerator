'use strict';

const crypto = require('crypto');
const { config } = require('./config');
const log = require('./logger');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Optional protection for the public callback URL. Bandwidth supports both
 * Basic auth on the callback and an arbitrary query string, so either can be
 * configured; when neither is set the endpoint is open (fine behind a firewall
 * or an Apache-level IP allow-list).
 */
function webhookAuth(req, res, next) {
  const { username, password, token } = config.webhook;

  if (token) {
    const supplied = req.query.token || req.get('X-Webhook-Token') || '';
    if (!safeEqual(supplied, token)) {
      log.warn('webhook rejected: bad token', { ip: req.ip, path: req.path });
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  if (username) {
    const header = req.get('Authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (!encoded || String(scheme).toLowerCase() !== 'basic') {
      res.set('WWW-Authenticate', 'Basic realm="bandwidth-webhook"');
      return res.status(401).json({ error: 'unauthorized' });
    }
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (!safeEqual(user, username) || !safeEqual(pass, password)) {
      log.warn('webhook rejected: bad basic auth', { ip: req.ip, path: req.path });
      res.set('WWW-Authenticate', 'Basic realm="bandwidth-webhook"');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  return next();
}

module.exports = { webhookAuth };
