'use strict';

/**
 * Minimal Bandwidth.com Messaging API v2 client.
 *
 * Outbound send:
 *   POST {baseUrl}/users/{accountId}/messages
 * Auth is HTTP Basic with the Messaging API token/secret pair.
 */

const crypto = require('crypto');
const { config } = require('./config');
const log = require('./logger');

const bw = config.bandwidth;

/**
 * A short, non-reversible fingerprint of a credential. Enough to confirm which
 * key is loaded, or that two hosts disagree, without printing the secret.
 */
function fingerprint(value) {
  if (!value) return 'empty';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Response headers worth keeping when a call fails. */
const INTERESTING_HEADERS = ['x-request-id', 'requestid', 'x-amzn-requestid', 'retry-after', 'content-type'];

function pickHeaders(res) {
  const out = {};
  for (const name of INTERESTING_HEADERS) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Bandwidth's 403 body says only "Access Denied", so spell out what actually
 * causes it. Ordered by how often each one is the answer.
 */
function explain(status, payload) {
  if (status === 403) {
    return [
      `the "from" number ${payload.from} is not assigned to application ${bw.applicationId}`,
      'BW_APPLICATION_ID belongs to a different account than BW_ACCOUNT_ID',
      'BW_API_TOKEN/BW_API_SECRET are dashboard credentials rather than Messaging API credentials',
      'the account lacks messaging permission for this number or destination',
    ];
  }
  if (status === 401) {
    return ['BW_API_TOKEN/BW_API_SECRET are wrong, or the user has no Messaging API role'];
  }
  if (status === 400) {
    return ['the payload was rejected: check "to"/"from" are E.164 and the text is not empty'];
  }
  if (status === 404) {
    return [`BW_ACCOUNT_ID ${bw.accountId} does not exist or is not visible to this user`];
  }
  return [];
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${bw.apiToken}:${bw.apiSecret}`).toString('base64');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, path, body) {
  const url = `${bw.baseUrl}/users/${encodeURIComponent(bw.accountId)}${path}`;
  let lastError;

  log.debug('bandwidth request', {
    method,
    url,
    accountId: bw.accountId,
    applicationId: bw.applicationId,
    tokenFingerprint: fingerprint(bw.apiToken),
    secretFingerprint: fingerprint(bw.apiSecret),
    payload: body,
  });

  for (let attempt = 0; attempt <= bw.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), bw.timeoutMs);
    const started = Date.now();

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

      const elapsedMs = Date.now() - started;
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {
        parsed = { raw: text };
      }

      if (res.ok) {
        log.debug('bandwidth response', {
          method, path, status: res.status, elapsedMs, body: parsed,
        });
        return parsed;
      }

      // Everything needed to diagnose the failure, in one line.
      log.error('bandwidth request rejected', {
        method,
        url,
        status: res.status,
        elapsedMs,
        attempt: attempt + 1,
        responseBody: parsed,
        responseHeaders: pickHeaders(res),
        accountId: bw.accountId,
        applicationId: bw.applicationId,
        tokenFingerprint: fingerprint(bw.apiToken),
        sent: body && { from: body.from, to: body.to, textChars: (body.text || '').length, media: (body.media || []).length },
        likelyCauses: explain(res.status, body || {}),
      });

      // 4xx other than 429 will not succeed on retry.
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`Bandwidth API ${method} ${path} failed: ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      if (!retryable) throw err;
      lastError = err;
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      if (!err.status) {
        log.error('bandwidth request failed before a response', {
          method,
          url,
          attempt: attempt + 1,
          elapsedMs: Date.now() - started,
          error: err.message,
          cause: err.cause && err.cause.message,
          hint: err.name === 'AbortError' ? `no response within BW_TIMEOUT_MS (${bw.timeoutMs}ms)` : undefined,
        });
      }
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

  log.info('sending reply', {
    to,
    from,
    chars: text.length,
    media: (media || []).length,
    applicationId: bw.applicationId,
  });

  const result = await request('POST', '/messages', payload);
  log.info('bandwidth accepted message', {
    outboundId: result && result.id,
    to,
    from,
    segments: result && result.segmentCount,
  });
  return result;
}

module.exports = { sendMessage, fingerprint };
