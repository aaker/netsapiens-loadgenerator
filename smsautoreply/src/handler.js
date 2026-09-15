'use strict';

/**
 * Inbound event processing: normalise the Bandwidth callback, decide whether
 * it needs an auto-reply, build the reply and send it.
 */

const { config } = require('./config');
const log = require('./logger');
const { sendMessage } = require('./bandwidth');
const { buildReply } = require('./reply');

/** Recently handled message ids, so Bandwidth retries do not double-reply. */
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 5000;

function alreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(key);
    else break; // Map preserves insertion order; the rest are newer.
  }
  if (seen.has(id)) return true;
  seen.set(id, now);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return false;
}

/**
 * Bandwidth posts an array of events; a single object is accepted too so the
 * endpoint is easy to exercise by hand.
 */
function normalizeEvents(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') return [body];
  return [];
}

function isInboundMessage(event) {
  const message = event && event.message;
  if (!message) return false;
  const type = String(event.type || '').toLowerCase();
  const direction = String(message.direction || '').toLowerCase();
  return type === 'message-received' || (type === '' && direction === 'in');
}

/**
 * The number the reply is sent from: the configured override, otherwise the
 * number the inbound message was addressed to.
 */
function replyFrom(event) {
  if (config.bandwidth.fromNumber) return config.bandwidth.fromNumber;
  const message = event.message || {};
  if (message.owner) return message.owner;
  if (Array.isArray(message.to) && message.to.length) return message.to[0];
  return event.to || null;
}

async function handleEvent(event, meta) {
  if (!isInboundMessage(event)) {
    log.debug('ignoring non-inbound event', { type: event && event.type, requestId: meta.requestId });
    return { status: 'ignored', reason: 'not an inbound message' };
  }

  const message = event.message;
  const to = message.from;
  const from = replyFrom(event);

  log.info('inbound message', {
    requestId: meta.requestId,
    messageId: message.id,
    from: message.from,
    to: message.to,
    owner: message.owner,
    segments: message.segmentCount,
    media: (message.media || []).length,
    chars: (message.text || '').length,
  });

  if (alreadyHandled(message.id)) {
    log.info('duplicate callback, no reply sent', { requestId: meta.requestId, messageId: message.id });
    return { status: 'duplicate' };
  }

  if (!to || !from) {
    log.warn('cannot determine reply addresses', { requestId: meta.requestId, to, from });
    return { status: 'skipped', reason: 'missing to/from' };
  }

  if (to === from) {
    // Replying to ourselves would loop forever.
    log.warn('reply target equals source, skipping', { requestId: meta.requestId, number: to });
    return { status: 'skipped', reason: 'loop guard' };
  }

  const { text, data } = await buildReply(message, meta);

  if (config.reply.dryRun) {
    log.info('DRY_RUN: reply not sent', { requestId: meta.requestId, to, from, text });
    return { status: 'dry-run', to, from, data };
  }

  const result = await sendMessage({
    to,
    from,
    text,
    tag: `autoreply:${message.id || meta.requestId}`,
  });

  log.info('reply sent', {
    requestId: meta.requestId,
    inboundId: message.id,
    outboundId: result && result.id,
    to,
    from,
  });

  return { status: 'sent', outboundId: result && result.id, data };
}

/**
 * Process every event in one callback body. Never throws: a failure on one
 * event is logged and the rest still run.
 */
async function handleCallback(body, meta) {
  const events = normalizeEvents(body);
  const results = [];

  for (const event of events) {
    try {
      results.push(await handleEvent(event, meta));
    } catch (err) {
      log.error('failed to handle event', {
        requestId: meta.requestId,
        error: err.message,
        status: err.status,
        body: err.body,
      });
      results.push({ status: 'error', error: err.message });
    }
  }

  return results;
}

module.exports = { handleCallback, handleEvent, normalizeEvents };
