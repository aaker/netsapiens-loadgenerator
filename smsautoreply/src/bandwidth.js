'use strict';

/**
 * Minimal Bandwidth.com Messaging API v2 client.
 *
 * Outbound send:
 *   POST {baseUrl}/users/{accountId}/messages
 * Auth is HTTP Basic with the Messaging API token/secret pair.
 */

const { config } = require('./config');
const log = require('./logger');

const bw = config.bandwidth;

function authHeader() {
  return 'Basic ' + Buffer.from(`${bw.apiToken}:${bw.apiSecret}`).toString('base64');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, path, body) {
  const url = `${bw.baseUrl}/users/${encodeURIComponent(bw.accountId)}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= bw.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), bw.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {
        parsed = { raw: text };
      }

      if (res.ok) return parsed;

      // 4xx other than 429 will not succeed on retry.
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`Bandwidth API ${method} ${path} failed: ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      if (!retryable) throw err;
      lastError = err;
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < bw.retries) {
      const backoff = 250 * Math.pow(2, attempt);
      log.warn('bandwidth request failed, retrying', {
        attempt: attempt + 1,
        backoffMs: backoff,
        error: lastError && lastError.message,
      });
      await sleep(backoff);
    }
  }

  throw lastError;
}

/**
 * Send an SMS or MMS.
 *
 * @param {object} opts
 * @param {string}   opts.to            E.164 destination
 * @param {string}   opts.from          E.164 source (must be on the application)
 * @param {string}   opts.text          Message body
 * @param {string[]} [opts.media]       Publicly reachable media URLs -> MMS
 * @param {string}   [opts.tag]         Free-form tag echoed on status callbacks
 */
async function sendMessage({ to, from, text, media, tag }) {
  const payload = {
    applicationId: bw.applicationId,
    to: [to],
    from,
    text,
  };
  if (media && media.length) payload.media = media;
  if (tag) payload.tag = tag;

  log.debug('sending message', { to, from, chars: text.length, media: (media || []).length });
  return request('POST', '/messages', payload);
}

module.exports = { sendMessage };
