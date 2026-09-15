#!/usr/bin/env node
'use strict';

/**
 * Send one message straight through the Bandwidth client, bypassing the
 * webhook. Use this to separate an outbound credential/number problem from a
 * problem in the callback path.
 *
 *   node scripts/send-direct.js --to +19195551212
 *   node scripts/send-direct.js --to +19195551212 --from +18583938801 --text hi
 *   node scripts/send-direct.js --show            # print config only, send nothing
 *
 * Run it from the app directory so it reads the same .env as the service.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

const { config, validate } = require('../src/config');
const { sendMessage, fingerprint } = require('../src/bandwidth');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const bw = config.bandwidth;

console.log('--- configuration -----------------------------------------');
console.log(`  baseUrl         ${bw.baseUrl}`);
console.log(`  accountId       ${bw.accountId || '(unset)'}`);
console.log(`  applicationId   ${bw.applicationId || '(unset)'}`);
console.log(`  apiToken        ${bw.apiToken ? `set, fingerprint ${fingerprint(bw.apiToken)}` : '(unset)'}`);
console.log(`  apiSecret       ${bw.apiSecret ? `set, fingerprint ${fingerprint(bw.apiSecret)}` : '(unset)'}`);
console.log(`  fromNumber      ${bw.fromNumber || '(unset - replies use the number that was messaged)'}`);
console.log(`  dryRun          ${config.reply.dryRun}`);

const problems = validate();
if (problems.length) {
  console.log('--- problems ----------------------------------------------');
  for (const p of problems) console.log(`  ! ${p}`);
}

if (process.argv.includes('--show')) process.exit(problems.length ? 1 : 0);

const to = arg('to');
const from = arg('from', bw.fromNumber);
const text = arg('text', `smsautoreply direct test ${new Date().toISOString()}`);

if (!to) {
  console.error('\n--to is required (E.164, e.g. --to +19195551212)');
  process.exit(2);
}
if (!from) {
  console.error('\n--from is required when BW_FROM_NUMBER is unset');
  process.exit(2);
}

console.log('--- sending -----------------------------------------------');
sendMessage({ to, from, text, tag: 'send-direct' })
  .then((result) => {
    console.log('\nOK:', JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    if (err.body) console.error('response:', JSON.stringify(err.body, null, 2));
    process.exit(1);
  });
