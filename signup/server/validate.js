const { isValidNpa } = require('./npa-data');
const { isFreeMail } = require('./freemail');

// Public/free/disposable-mail hosts are rejected because the email hostname
// becomes the tenant domain — a second gmail.com signup would land inside the
// first tester's domain. See server/freemail.js for the blocklist sources.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const COMPANY_RE = /^[A-Za-z0-9 &().,'-]{2,64}$/;

function clean(str) {
  return String(str || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns { error: {field, message} } or { value: {...normalized fields} }
function validateSignup(body) {
  if (!body || typeof body !== 'object') {
    return { error: { field: null, message: 'Invalid request body' } };
  }

  const fullName = clean(body.fullName);
  if (fullName.length < 2 || fullName.length > 64) {
    return { error: { field: 'fullName', message: 'Please enter your full name (2-64 characters)' } };
  }
  const lastSpace = fullName.lastIndexOf(' ');
  const firstName = lastSpace > 0 ? fullName.slice(0, lastSpace) : fullName;
  const lastName = lastSpace > 0 ? fullName.slice(lastSpace + 1) : 'User';

  const companyName = clean(body.companyName);
  if (!COMPANY_RE.test(companyName)) {
    return { error: { field: 'companyName', message: "Company name must be 2-64 characters (letters, numbers, and &().,'- only)" } };
  }

  const email = clean(body.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 128) {
    return { error: { field: 'email', message: 'Please enter a valid email address' } };
  }
  const hostname = email.split('@')[1];
  if (!HOSTNAME_RE.test(hostname) || hostname.length > 64) {
    return { error: { field: 'email', message: 'Email domain is not a valid hostname' } };
  }
  if (isFreeMail(hostname)) {
    return { error: { field: 'email', message: 'Please use your company email address (personal email providers are not supported)' } };
  }

  const areaCode = clean(body.areaCode);
  if (!/^[2-9]\d{2}$/.test(areaCode) || !isValidNpa(areaCode)) {
    return { error: { field: 'areaCode', message: 'Please enter a valid US area code' } };
  }

  if (body.ack911 !== true) {
    return { error: { field: 'ack911', message: 'You must acknowledge that 911 emergency services are not available on this system' } };
  }
  if (body.ackNoSla !== true) {
    return { error: { field: 'ackNoSla', message: 'You must acknowledge that this system is for early testing only with no SLA' } };
  }

  return {
    value: { fullName, firstName, lastName, companyName, email, domain: hostname, areaCode, ack911: true, ackNoSla: true }
  };
}

module.exports = { validateSignup };
