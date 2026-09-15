'use strict';

/**
 * Configuration loader. Everything comes from the environment (.env in dev,
 * systemd EnvironmentFile or Apache SetEnv in production).
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback = false) {
  const v = str(name, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const config = {
  bandwidth: {
    accountId: str('BW_ACCOUNT_ID'),
    apiToken: str('BW_API_TOKEN'),
    apiSecret: str('BW_API_SECRET'),
    applicationId: str('BW_APPLICATION_ID'),
    baseUrl: str('BW_MESSAGING_BASE_URL', 'https://messaging.bandwidth.com/api/v2').replace(/\/+$/, ''),
    fromNumber: str('BW_FROM_NUMBER'),
    timeoutMs: int('BW_TIMEOUT_MS', 10000),
    retries: int('BW_RETRIES', 2),
  },
  webhook: {
    path: str('WEBHOOK_PATH', '/webhooks/bandwidth/inbound'),
    // NetSapiens-shaped endpoint: POST /ns-api/?object=sms&action=create
    nsApiPath: str('NSAPI_PATH', '/ns-api/'),
    nsApiObject: str('NSAPI_OBJECT', 'sms'),
    nsApiAction: str('NSAPI_ACTION', 'create'),
    // 0 accepts any query string on the ns-api path
    nsApiRequireQuery: bool('NSAPI_REQUIRE_QUERY', true),
    username: str('WEBHOOK_USERNAME'),
    password: str('WEBHOOK_PASSWORD'),
    token: str('WEBHOOK_TOKEN'),
  },
  server: {
    port: int('PORT', 3010),
    bindAddress: str('BIND_ADDRESS', '127.0.0.1'),
    trustProxy: bool('TRUST_PROXY', true),
  },
  reply: {
    dryRun: bool('DRY_RUN', false),
    maxEchoChars: int('REPLY_MAX_ECHO_CHARS', 800),
  },
  logLevel: str('LOG_LEVEL', 'info'),
};

/**
 * Returns a list of human-readable problems; empty when the config is usable.
 */
function validate() {
  const problems = [];
  const bw = config.bandwidth;

  if (!bw.accountId) {
    problems.push('BW_ACCOUNT_ID is not set');
  } else if (!/^\d+$/.test(bw.accountId)) {
    // The account id goes in the request path; a username or email there is
    // accepted by the URL and then rejected as 403 Access Denied.
    problems.push(
      `BW_ACCOUNT_ID must be the numeric account id from the Bandwidth dashboard, not "${bw.accountId}". ` +
      'A username or email belongs in BW_API_TOKEN/BW_API_SECRET.'
    );
  }
  if (!bw.apiToken) problems.push('BW_API_TOKEN is not set');
  if (!bw.apiSecret) problems.push('BW_API_SECRET is not set');
  if (!bw.applicationId) problems.push('BW_APPLICATION_ID is not set');
  if (bw.fromNumber && !/^\+[1-9]\d{6,14}$/.test(bw.fromNumber)) {
    problems.push('BW_FROM_NUMBER must be E.164 (e.g. +19195551212)');
  }
  if (!config.webhook.path.startsWith('/')) {
    problems.push('WEBHOOK_PATH must start with /');
  }
  if (config.webhook.nsApiPath && !config.webhook.nsApiPath.startsWith('/')) {
    problems.push('NSAPI_PATH must start with /');
  }
  if (config.webhook.username && !config.webhook.password) {
    problems.push('WEBHOOK_USERNAME is set but WEBHOOK_PASSWORD is not');
  }

  return problems;
}

module.exports = { config, validate };
