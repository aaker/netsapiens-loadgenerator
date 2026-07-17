// Direct SMTP sender for the welcome email. Replaces the NetSapiens platform
// email (ns.sendWelcomeEmail) so we control the content and can surface what
// the signup flow actually provisioned: the domain, the reseller we claimed,
// and that it's all fake test data. The template placeholders are filled here
// from the job's provisioning result — the NS server never renders anything.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const TEMPLATE_FILE = path.join(__dirname, '..', 'email-templates', 'welcome_email.html');

let templateCache = null;
function loadTemplate() {
  if (templateCache === null) templateCache = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  return templateCache;
}

// Minimal HTML escaping for values interpolated into the template. Company
// names and person names are user-supplied; keep them from breaking layout.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(data) {
  const fqdn = process.env.PORTAL_FQDN || process.env.TARGET_SERVER;
  const values = {
    FQDN: esc(fqdn),
    DOMAIN: esc(data.domain),
    LOGIN: esc(data.login),
    USER: esc(data.user),
    USER_NAME: esc(data.userName),
    RESELLER: esc(data.reseller || '—'),
    COMPANY: esc(data.company),
    DID: esc(data.phoneNumber || ''),
    DID_DISPLAY: data.phoneNumber ? 'table-row' : 'none',
    SUPPORT_LINK: esc(process.env.SUPPORT_LINK || `https://${fqdn}/`),
    POWERED_BY: esc(process.env.EMAIL_POWERED_BY || 'NetSapiens Beta')
  };
  return loadTemplate().replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m);
}

let transportCache = null;
function getTransport() {
  if (transportCache) return transportCache;
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error('SMTP_HOST is not configured');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const opts = {
    host,
    port,
    // Implicit TLS on 465; STARTTLS (or plain) otherwise. Override with SMTP_SECURE.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : port === 465
  };
  // On a non-implicit-TLS port (e.g. 587), require STARTTLS by default so we
  // never fall back to cleartext. Set SMTP_REQUIRE_TLS=0 to allow plaintext
  // (e.g. a trusted local relay that doesn't offer STARTTLS).
  if (!opts.secure && process.env.SMTP_REQUIRE_TLS !== '0') {
    opts.requireTLS = true;
  }
  if (process.env.SMTP_USER) {
    opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
  }
  if (process.env.SMTP_TLS_REJECT_UNAUTHORIZED === '0') {
    opts.tls = { rejectUnauthorized: false };
  }
  transportCache = nodemailer.createTransport(opts);
  return transportCache;
}

// Send the welcome email. `data` comes from the provisioner and must include:
// domain, user, login, userName, company; optional: reseller, phoneNumber.
// Throws on failure — the provisioner treats send-welcome as non-fatal.
async function sendWelcomeEmail(data) {
  const html = render(data);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) throw new Error('SMTP_FROM (or SMTP_USER) is not configured');
  const fqdn = process.env.PORTAL_FQDN || process.env.TARGET_SERVER;
  await getTransport().sendMail({
    from,
    to: data.email,
    cc: "caaker@crexendo.com, alighterink@crexendo.com",
    subject: process.env.WELCOME_SUBJECT || `Your new test account for ${fqdn}`,
    html
  });
}

module.exports = { sendWelcomeEmail, render };
