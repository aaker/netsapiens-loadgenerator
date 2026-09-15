'use strict';

/**
 * Builds the auto-reply body.
 *
 * This is the file to edit when the reply content changes: `enrich()` produces
 * the "new data" side of the reply, `buildReply()` glues it to an echo of the
 * inbound post.
 */

const os = require('os');
const { config } = require('./config');
const pkg = require('../package.json');

const startedAt = Date.now();

/**
 * The "new data" half of the reply. Everything here is generated locally, so
 * it never blocks on an external lookup. Add fields (CRM lookups, queue depth,
 * ticket ids, ...) by making this async and awaiting inside it - buildReply()
 * already awaits the result.
 *
 * @param {object} message  Bandwidth inbound `message` object
 * @param {object} meta     { requestId, receivedAt, eventType }
 */
async function enrich(message, meta) {
  const now = new Date();

  return {
    received: now.toISOString(),
    host: os.hostname(),
    service: `${pkg.name} v${pkg.version}`,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    request_id: meta.requestId,
    message_id: message.id || 'unknown',
    type: (message.media && message.media.length) ? 'MMS' : 'SMS',
    segments: message.segmentCount != null ? message.segmentCount : 1,
    media_count: (message.media || []).length,
  };
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)) + '...';
}

/**
 * Compose the outbound reply text: a block of generated data followed by a
 * verbatim echo of the inbound payload.
 *
 * @returns {Promise<{text: string, data: object}>}
 */
async function buildReply(message, meta) {
  const data = await enrich(message, meta);

  const header = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const echo = JSON.stringify(message, null, 0);

  const text = [
    'Auto-reply',
    header,
    '--- your message ---',
    truncate(echo, config.reply.maxEchoChars),
  ].join('\n');

  // SMS bodies over 1600 chars are rejected by the carrier; keep headroom.
  return { text: truncate(text, 1500), data };
}

module.exports = { buildReply, enrich };
