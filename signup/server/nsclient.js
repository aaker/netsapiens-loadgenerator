// NetSapiens API v2 client. Modeled on lib/nsapi.js (base URL, Bearer auth,
// synchronous:'yes', retry policy) but promise-based with typed errors so the
// provisioner can distinguish 404 / 409 / failure.

const axios = require('axios');
const https = require('https');

const API_DEBUG = process.env.API_DEBUG === '1';
const RETRY = { maxRetries: 3, baseDelay: 1000, maxDelay: 10000 };
const RETRYABLE_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'];

const client = axios.create({
  timeout: 30000,
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5, rejectUnauthorized: true })
});

class NsError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'NsError';
    this.status = status || null;
    this.data = data || null;
  }
}

function isConflict(err) { return err instanceof NsError && err.status === 409; }
function isNotFound(err) { return err instanceof NsError && err.status === 404; }

function isRetryable(err) {
  if (err.code && RETRYABLE_CODES.includes(err.code)) return true;
  return !!(err.response && err.response.status >= 500);
}

function debugBody(data, limit) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > (limit || 2000) ? s.slice(0, limit || 2000) + '…[truncated]' : s;
  } catch {
    return String(data);
  }
}

async function request(method, apiPath, data) {
  const hostname = process.env.TARGET_SERVER;
  const url = `https://${hostname}/ns-api/v2/${apiPath}`;
  let attempt = 0;
  for (;;) {
    try {
      if (API_DEBUG) console.log(`NS ${method.toUpperCase()} ${url}`, data ? JSON.stringify(data) : '');
      const response = await client.request({
        method, url, data,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.APIKEY}`
        }
      });
      if (API_DEBUG) console.log(`NS ${method.toUpperCase()} ${apiPath} <- ${response.status}`, debugBody(response.data));
      return response.data;
    } catch (err) {
      if (API_DEBUG && err.response) {
        console.log(`NS ${method.toUpperCase()} ${apiPath} <- ${err.response.status} ${err.response.statusText}`, debugBody(err.response.data));
      } else if (API_DEBUG) {
        console.log(`NS ${method.toUpperCase()} ${apiPath} <- network error: ${err.code || err.message}`);
      }
      if (isRetryable(err) && attempt < RETRY.maxRetries) {
        const delay = Math.min(RETRY.baseDelay * Math.pow(2, attempt), RETRY.maxDelay);
        attempt++;
        console.warn(`NS ${method.toUpperCase()} ${apiPath} failed (${err.response ? err.response.status : err.code}), retry ${attempt}/${RETRY.maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (err.response) {
        throw new NsError(`NS API ${method.toUpperCase()} ${apiPath} -> ${err.response.status} ${err.response.statusText}`, err.response.status, err.response.data);
      }
      throw new NsError(`NS API ${method.toUpperCase()} ${apiPath} -> ${err.code || err.message}`, null, null);
    }
  }
}

// --- Domain-level helpers ---

async function getDomain(domain) {
  try {
    const data = await request('get', `domains/${encodeURIComponent(domain)}`);
    if (Array.isArray(data)) return data.length ? data[0] : null;
    return data || null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function listResellers() {
  const data = await request('get', 'resellers');
  return Array.isArray(data) ? data : (data && data.items) || [];
}

function updateReseller(reseller, description) {
  return request('put', `resellers/${encodeURIComponent(reseller)}`, {
    synchronous: 'yes', reseller, description
  });
}

function createDomain(payload) {
  return request('post', 'domains', Object.assign({ synchronous: 'yes' }, payload));
}

async function listUsers(domain) {
  const data = await request('get', `domains/${encodeURIComponent(domain)}/users`);
  return Array.isArray(data) ? data : (data && data.items) || [];
}

function createUser(domain, payload) {
  return request('post', `domains/${encodeURIComponent(domain)}/users`, Object.assign({ synchronous: 'yes' }, payload));
}

// "Send Email using Template" — POST domains/{domain}/users/{user}/email
// Failure is treated as non-fatal by the provisioner.
function sendWelcomeEmail(domain, user) {
  return request('post', `domains/${encodeURIComponent(domain)}/users/${encodeURIComponent(user)}/email`, {
    template: process.env.WELCOME_TEMPLATE || 'custom_welcome_email_reseller.php',
    subject: process.env.WELCOME_SUBJECT || 'New Account Setup'
  });
}

function addPhonenumber(domain, payload) {
  return request('post', `domains/${encodeURIComponent(domain)}/phonenumbers`, Object.assign({ synchronous: 'yes' }, payload));
}

module.exports = {
  NsError, isConflict, isNotFound,
  getDomain, listResellers, updateReseller, createDomain,
  listUsers, createUser, sendWelcomeEmail, addPhonenumber
};
