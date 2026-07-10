// Inteliquent (Sinch/Voyant) Services API client.
// Credentials are the portal's API Key + API Secret (Admin > API Key). The
// docs call the same pair client_id/client_secret for OAuth, and the API Key
// again as "privateKey" in every request body. Transport auth tries OAuth
// bearer first and falls back to HTTP Basic (both are officially supported).
// SIGNUP_DRY_RUN=1 short-circuits everything with a fake number (no HTTP).

const axios = require('axios');
const { stateOf, npasOf } = require('./npa-data');

const API_DEBUG = process.env.API_DEBUG === '1';

class IqError extends Error {
  constructor(message, statusCode, data) {
    super(message);
    this.name = 'IqError';
    this.statusCode = statusCode || null;
    this.data = data || null;
  }
}

function isDryRun() { return process.env.SIGNUP_DRY_RUN === '1'; }

function debugBody(data, limit) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > (limit || 2000) ? s.slice(0, limit || 2000) + '…[truncated]' : s;
  } catch {
    return String(data);
  }
}

let tokenCache = { token: null, expiresAt: 0 };
let useBasicAuth = false; // sticky fallback once the token endpoint rejects us

async function getToken(forceRefresh) {
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const response = await axios.post(
    process.env.INTELIQUENT_TOKEN_URL,
    new URLSearchParams({
      client_id: process.env.INTELIQUENT_API_KEY,
      client_secret: process.env.INTELIQUENT_API_SECRET,
      grant_type: 'client_credentials'
    }).toString(),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  // Tokens expire after ~1 hour regardless of the reported expires_in; cache 55min
  tokenCache = { token: response.data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return tokenCache.token;
}

async function authHeader(forceRefresh) {
  if (!useBasicAuth) {
    try {
      return `Bearer ${await getToken(forceRefresh)}`;
    } catch (err) {
      const status = err.response && err.response.status;
      if (status && status >= 400 && status < 500) {
        console.warn(`Inteliquent token endpoint rejected credentials (${status}); falling back to Basic auth`);
        useBasicAuth = true;
      } else {
        throw new IqError(`Inteliquent token request failed -> ${status || err.code}`, status, err.response ? err.response.data : null);
      }
    }
  }
  const pair = `${process.env.INTELIQUENT_API_KEY}:${process.env.INTELIQUENT_API_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function iqPost(endpoint, body, retriedAuth) {
  const auth = await authHeader(retriedAuth);
  const url = `${process.env.INTELIQUENT_API_BASE}/${endpoint}`;
  const payload = Object.assign({ privateKey: process.env.INTELIQUENT_API_KEY }, body);
  try {
    if (API_DEBUG) console.log(`IQ POST ${endpoint}`, JSON.stringify(body));
    const response = await axios.post(url, payload, {
      headers: { 'content-type': 'application/json', authorization: auth },
      timeout: 30000
    });
    if (API_DEBUG) console.log(`IQ ${endpoint} <- ${response.status}`, debugBody(response.data));
    return response.data;
  } catch (err) {
    if (API_DEBUG && err.response) {
      console.log(`IQ ${endpoint} <- ${err.response.status}`, debugBody(err.response.data));
    } else if (API_DEBUG) {
      console.log(`IQ ${endpoint} <- network error: ${err.code || err.message}`);
    }
    if (err.response && err.response.status === 401) {
      if (!retriedAuth) return iqPost(endpoint, body, true);
      if (!useBasicAuth) { useBasicAuth = true; return iqPost(endpoint, body, true); }
    }
    const status = err.response ? err.response.status : err.code;
    throw new IqError(`Inteliquent ${endpoint} -> ${status}`, status, err.response ? err.response.data : null);
  }
}

// Returns up to `quantity` available 10-digit numbers in the NPA ([] if none).
async function searchNumbers(npa, quantity) {
  const data = await iqPost('tnInventory', {
    tnMask: `${npa}xxxxxxx`,
    quantity: quantity || 5,
    searchOnNetOnly: 'N'
  });
  if (String(data.statusCode) === '430') return []; // no inventory
  if (String(data.statusCode) !== '200') {
    throw new IqError(`tnInventory failed: ${data.status}`, data.statusCode, data);
  }
  const results = (data.tnResult && (Array.isArray(data.tnResult) ? data.tnResult : [data.tnResult])) || [];
  return results.map(r => String(r.telephoneNumber)).filter(tn => /^\d{10}$/.test(tn));
}

// NPAs in the same state ranked by available inventory count (descending).
async function coverageByState(state) {
  const data = await iqPost('tnInventoryCoverage', { countBy: 'npaNxx', province: state });
  if (String(data.statusCode) !== '200') return [];
  const list = data.tnInventoryCoverageList || [];
  const byNpa = new Map();
  for (const item of list) {
    const npa = String(item.npa);
    byNpa.set(npa, (byNpa.get(npa) || 0) + (Number(item.count) || 0));
  }
  return [...byNpa.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([npa]) => npa);
}

// Find candidate numbers: exact NPA first, then same-state NPAs by inventory
// count. Never buys cross-state silently. Returns { npaUsed, tns } or null.
async function findCandidates(npa) {
  const exact = await searchNumbers(npa, 5);
  if (exact.length) return { npaUsed: npa, tns: exact };

  const state = stateOf(npa);
  if (!state) return null;

  let nearby = await coverageByState(state);
  if (!nearby.length) {
    // Coverage can be sparse/unavailable; fall back to brute-force same-state NPAs
    nearby = npasOf(state);
  }
  for (const candidateNpa of nearby) {
    if (candidateNpa === npa) continue;
    const tns = await searchNumbers(candidateNpa, 5);
    if (tns.length) return { npaUsed: candidateNpa, tns };
  }
  return null;
}

// Order one specific TN onto our trunk group. A single featureless TN order is
// synchronous (orderId null) — success/failure is in the status fields.
async function orderNumber(tn, jobId) {
  const data = await iqPost('tnOrder', {
    tnOrder: {
      customerOrderReference: `signup-${jobId}`,
      tnList: {
        tnItem: [{ tn: Number(tn), trunkGroup: process.env.INTELIQUENT_TRUNK_GROUP }]
      }
    }
  });
  const statusText = JSON.stringify(data.status || '');
  if (String(data.statusCode) !== '200' || /existing order|error|fail/i.test(statusText)) {
    throw new IqError(`tnOrder for ${tn} failed: ${statusText}`, data.statusCode, data);
  }
  return data;
}

// Full purchase flow. Returns { tn, npaUsed } or throws IqError with
// code 'NO_NUMBERS' when no same-state inventory exists.
async function purchaseNumberNear(npa, jobId) {
  if (isDryRun()) {
    return { tn: `${npa}5550100`, npaUsed: npa, dryRun: true };
  }
  const candidates = await findCandidates(npa);
  if (!candidates) {
    const err = new IqError(`No number inventory available in or near area code ${npa}`, 'NO_NUMBERS', null);
    err.code = 'NO_NUMBERS';
    throw err;
  }
  let lastErr = null;
  for (const tn of candidates.tns.slice(0, 3)) {
    try {
      await orderNumber(tn, jobId);
      return { tn, npaUsed: candidates.npaUsed, dryRun: false };
    } catch (err) {
      lastErr = err;
      console.warn(`tnOrder failed for ${tn}, trying next candidate: ${err.message}`);
    }
  }
  throw lastErr || new IqError('Number purchase failed', null, null);
}

module.exports = { IqError, purchaseNumberNear, searchNumbers, coverageByState, isDryRun };
