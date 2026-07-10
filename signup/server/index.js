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

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));
app.use('/api', routes);

const distDir = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res) => {
  const indexFile = path.join(distDir, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(503).send('Client not built. Run: npm run build');
});

const port = parseInt(process.env.SIGNUP_PORT || '3100', 10);
app.listen(port, () => {
  console.log(`Signup server listening on :${port} (target: ${process.env.TARGET_SERVER}, dry-run: ${process.env.SIGNUP_DRY_RUN === '1' ? 'on' : 'off'})`);
});
