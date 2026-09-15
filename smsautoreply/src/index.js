'use strict';

const crypto = require('crypto');
const express = require('express');

const { config, validate } = require('./config');
const log = require('./logger');
const { webhookAuth } = require('./auth');
const { handleCallback } = require('./handler');

const app = express();

if (config.server.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

// Bandwidth posts application/json; keep the raw body around in case a
// signature check is added later.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use((req, _res, next) => {
  req.id = req.get('X-Request-Id') || crypto.randomUUID();
  next();
});

app.get('/health', (_req, res) => {
  const problems = validate();
  res.status(problems.length ? 503 : 200).json({
    status: problems.length ? 'degraded' : 'ok',
    dryRun: config.reply.dryRun,
    problems,
  });
});

/**
 * Bandwidth inbound message callback.
 *
 * The 200 is returned immediately and the reply is sent afterwards: Bandwidth
 * retries the callback if it does not get a prompt 2xx, and a retry would mean
 * a duplicate reply.
 */
app.post(config.webhook.path, webhookAuth, (req, res) => {
  const meta = {
    requestId: req.id,
    receivedAt: new Date().toISOString(),
    remoteIp: req.ip,
  };

  log.debug('callback received', { requestId: req.id, body: req.body });
  res.status(200).json({ status: 'accepted', requestId: req.id });

  handleCallback(req.body, meta).catch((err) => {
    log.error('callback processing failed', { requestId: req.id, error: err.message });
  });
});

// Bandwidth sends message-delivered / message-failed to the status callback.
// Point the application's status URL here to log delivery outcomes.
app.post(config.webhook.path + '/status', webhookAuth, (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) {
    log.info('status callback', {
      requestId: req.id,
      type: event && event.type,
      messageId: event && event.message && event.message.id,
      description: event && event.description,
      errorCode: event && event.errorCode,
    });
  }
  res.status(200).json({ status: 'accepted' });
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, _next) => {
  log.error('unhandled error', { requestId: req.id, error: err.message });
  res.status(err.status || 500).json({ error: 'internal error', requestId: req.id });
});

const problems = validate();
if (problems.length) {
  // Not fatal: the process still starts so /health can report what is missing.
  log.warn('configuration incomplete', { problems });
}

const server = app.listen(config.server.port, config.server.bindAddress, () => {
  log.info('listening', {
    address: `${config.server.bindAddress}:${config.server.port}`,
    webhookPath: config.webhook.path,
    dryRun: config.reply.dryRun,
    authenticated: Boolean(config.webhook.username || config.webhook.token),
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

module.exports = app;
