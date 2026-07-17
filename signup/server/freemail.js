// Public/free/disposable email blocklist. The signup form must accept only
// real company email, because the email hostname becomes the tenant domain —
// a personal or throwaway address would collide tenants and defeats the
// "one company, one domain" model.
//
// Sources, merged into one lookup Set (built lazily, once):
//   - free-email-domains        (~13k free consumer providers: gmail, yahoo, …)
//   - disposable-email-domains  (~121k throwaway/temp-mail providers)
//   - server/freemail-extra.txt (checked-in supplemental list, easy to extend)
//   - $FREEMAIL_EXTRA_FILE       (optional deployment-specific extra list)
// Minus any hosts in $FREEMAIL_ALLOW (comma-separated force-allow overrides,
// for a legitimate company domain that a public list flags by mistake).

const fs = require('fs');
const path = require('path');

let freeSet = null;

function loadPackageList(name) {
  try {
    const arr = require(name);
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.warn(`freemail: optional list "${name}" not installed — coverage reduced`);
    return [];
  }
}

function loadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function build() {
  const s = new Set();
  for (const d of loadPackageList('free-email-domains')) s.add(String(d).toLowerCase());
  for (const d of loadPackageList('disposable-email-domains')) s.add(String(d).toLowerCase());
  for (const d of loadFile(path.join(__dirname, 'freemail-extra.txt'))) s.add(d);
  if (process.env.FREEMAIL_EXTRA_FILE) {
    for (const d of loadFile(process.env.FREEMAIL_EXTRA_FILE)) s.add(d);
  }
  const allow = (process.env.FREEMAIL_ALLOW || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const d of allow) s.delete(d);
  return s;
}

function getSet() {
  if (!freeSet) freeSet = build();
  return freeSet;
}

// True if hostname is a known public/free/disposable mail provider. Matches the
// exact host and any parent domain, so a subdomained free host is caught too
// (e.g. mail.gmail.com -> gmail.com).
function isFreeMail(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  const set = getSet();
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (set.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

function size() { return getSet().size; }

module.exports = { isFreeMail, size };
