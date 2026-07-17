const path = require('path');
const fs = require('fs');
// signup/.env first, repo root .env as fallback (dotenv never overwrites)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const express = require('express');
const routes = require('./routes');

const missing = ['TARGET_SERVER', 'APIKEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')} (set in signup/.env or repo root .env)`);
  process.exit(1);
}
if (process.env.SIGNUP_DRY_RUN !== '1') {
  const iqMissing = ['INTELIQUENT_API_KEY', 'INTELIQUENT_API_SECRET', 'INTELIQUENT_TRUNK_GROUP']
    .filter(k => !process.env[k]);
  if (iqMissing.length) {
    console.error(`Missing Inteliquent env vars: ${iqMissing.join(', ')} (or set SIGNUP_DRY_RUN=1)`);
    process.exit(1);
  }
}

if (!process.env.SMTP_HOST) {
  console.warn('SMTP_HOST is not set — welcome emails will not be sent (send-welcome step will fail non-fatally). See README "Email / SMTP configuration".');
}

// Warm the free/disposable-mail blocklist at boot so the first signup isn't
// slowed by building the (~130k entry) lookup Set.
const { size: freeMailSize } = require('./freemail');
console.log(`Email blocklist loaded: ${freeMailSize()} public/free/disposable domains rejected at signup`);

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));

// The UI is served under a base path (v46lab.ucaas.tech/signup). Must match the
// `base` in client/vite.config.js — the built asset URLs are baked at build time.
const BASE = ('/' + (process.env.SIGNUP_BASE_PATH || '/signup').replace(/^\/+|\/+$/g, ''));

app.use(`${BASE}/api`, routes);

const distDir = path.join(__dirname, '..', 'client', 'dist');
app.use(BASE, express.static(distDir));
// SPA fallback for client-side routes under the base path.
app.get(`${BASE}/*`, (req, res) => {
  const indexFile = path.join(distDir, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(503).send('Client not built. Run: npm run build');
});
// Convenience: bare host / -> the app.
app.get('/', (req, res) => res.redirect(`${BASE}/`));

const port = parseInt(process.env.SIGNUP_PORT || '3100', 10);
app.listen(port, () => {
  console.log(`Signup server listening on :${port} (target: ${process.env.TARGET_SERVER}, dry-run: ${process.env.SIGNUP_DRY_RUN === '1' ? 'on' : 'off'})`);
});
