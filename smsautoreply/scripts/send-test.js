#!/usr/bin/env node
'use strict';

/**
 * Posts a sample Bandwidth inbound callback at the running service.
 *
 *   node scripts/send-test.js                       # SMS, local service
 *   node scripts/send-test.js --mms
 *   node scripts/send-test.js --url https://host/webhooks/bandwidth/inbound \
 *        --from +19195551212 --to +19195559999 --text "hello"
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const port = process.env.PORT || 3010;
const webhookPath = process.env.WEBHOOK_PATH || '/webhooks/bandwidth/inbound';
const url = arg('url', `http://127.0.0.1:${port}${webhookPath}`);
const from = arg('from', '+19195551212');
const to = arg('to', process.env.BW_FROM_NUMBER || '+19195559999');
const text = arg('text', 'Test message from send-test.js');

const now = new Date().toISOString();
const event = {
  type: 'message-received',
  time: now,
  description: 'Incoming message received',
  to,
  message: {
    id: `test-${Date.now()}`,
    owner: to,
    applicationId: process.env.BW_APPLICATION_ID || 'test-application-id',
    time: now,
    segmentCount: 1,
    direction: 'in',
    to: [to],
    from,
    text,
    ...(flag('mms') ? { media: ['https://messaging.bandwidth.com/api/v2/users/test/media/example.jpg'] } : {}),
  },
};

const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_USERNAME) {
  const pair = `${process.env.WEBHOOK_USERNAME}:${process.env.WEBHOOK_PASSWORD || ''}`;
  headers.Authorization = 'Basic ' + Buffer.from(pair).toString('base64');
}
const target = process.env.WEBHOOK_TOKEN
  ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(process.env.WEBHOOK_TOKEN)}`
  : url;

(async () => {
  const res = await fetch(target, { method: 'POST', headers, body: JSON.stringify([event]) });
  console.log(res.status, await res.text());
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
