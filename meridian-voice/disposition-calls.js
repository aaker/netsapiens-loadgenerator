#!/usr/bin/env node
//
// disposition-calls.js - after a Meridian Voice test call, act as the agents
// doing their wrap-up: find the call's CDRs and write each agent's
// disposition, reason and notes (lab.json flows.<flow>.dispositions).
//
//   node meridian-voice/disposition-calls.js --server <id> --flow <flow> --since <epoch seconds>
//        [--wait <seconds, default 600>] [--no-delay]
//
// Finds the CDRs from the flow's caller number since --since, waiting up to
// --wait seconds for every agent in the flow's dispositions to show up
// (CDRs land some time after the call ends). Each agent then "types" for a
// random 20-90s (--no-delay skips it) and writes
//   PUT /domains/{domain}/cdrs/{call-parent-cdr-id}
//   {call-disposition, call-disposition-reason, call-disposition-notes,
//    call-disposition-submitted-datetime}
// There is no separate CDR notes endpoint: the notes are
// call-disposition-notes. When two agents' legs share one parent CDR, the
// last agent's disposition wins and the notes carry both agents' entries.
//
// The dispositions and reasons come from lab.json and match the domain's
// call-center codes (build-domain.js creates them); a pair missing from the
// domain's active codes is warned about before writing.
//
// Finally it reads each CDR back and prints the recording, transcription and
// sentiment fields, to show whether the domain's call recording with
// transcription and sentiment ran.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.chdir(REPO);
require('dotenv').config({ path: path.join(REPO, '.env') });
const { loadConfig } = require('../lib/config');
const { ServerApiClient, describeApiError } = require('../lib/nsapi');
const { formatForApi } = require('../lib/agent-sim/time');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const lab = JSON.parse(fs.readFileSync(path.join(__dirname, 'lab.json'), 'utf8'));
const D = lab.domain;
const FLOW = arg('--flow');
const SINCE = parseInt(arg('--since', '0'), 10) * 1000;
const WAIT_MS = parseInt(arg('--wait', '600'), 10) * 1000;
const NO_DELAY = process.argv.includes('--no-delay');
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const flow = lab.flows[FLOW];
if (!flow || !SINCE) {
    console.error(`usage: disposition-calls.js --server <id> --flow <${Object.keys(lab.flows).join('|')}> --since <epoch seconds>`);
    process.exit(2);
}
const callerNumber = lab.callers[flow.caller].number;
const expected = Object.keys(flow.dispositions);

const { selectedServer } = loadConfig();
const client = new ServerApiClient(selectedServer);

function log(msg) {
    console.log(`[${selectedServer.id}/${D}] ${FLOW}: ${msg}`);
}

// Answered legs from this flow's caller that an expected agent took.
async function findLegs() {
    const res = await client.apiGet(`domains/${enc(D)}/cdrs`, {
        'datetime-start': formatForApi(SINCE - 60000, lab.timeZone),
        'datetime-end': formatForApi(Date.now() + 60000, lab.timeZone),
        caller: callerNumber,
        limit: 100
    });
    return (Array.isArray(res.data) ? res.data : []).filter(r =>
        expected.includes(String(r['call-term-user'])) &&
        r['call-answer-datetime'] && r['call-disconnect-datetime']);
}

// Warn when this flow's dispositions or reasons aren't active codes on the
// domain (the CDR fields take any string, so a mismatch would go unnoticed).
async function checkCodes() {
    let codes;
    try {
        codes = (await client.apiGet(`domains/${enc(D)}/callcenter-codes`, { active: 'yes' })).data || [];
    } catch (e) {
        log(`could not read the domain's call-center codes (${describeApiError(e)}) - writing anyway`);
        return;
    }
    const have = new Set(codes.map(c => `${c.type}:${String(c.name).toLowerCase()}`));
    for (const [ext, e] of Object.entries(flow.dispositions)) {
        if (!have.has(`disposition:${e.disposition.toLowerCase()}`)) log(`WARNING: disposition "${e.disposition}" (${ext}) is not an active code on ${D} - run build-domain.js`);
        if (!have.has(`call-reason:${e.reason.toLowerCase()}`)) log(`WARNING: reason "${e.reason}" (${ext}) is not an active code on ${D} - run build-domain.js`);
    }
}

async function main() {
    log(`looking for CDRs from ${callerNumber} since ${new Date(SINCE).toISOString()} (agents ${expected.join(', ')})`);
    let legs = [];
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        try {
            legs = await findLegs();
        } catch (e) {
            log(`CDR read failed: ${describeApiError(e)}`);
        }
        const agents = new Set(legs.map(r => String(r['call-term-user'])));
        if (expected.every(a => agents.has(a))) break;
        if (Date.now() > deadline) {
            log(`gave up waiting: found agents [${[...agents].join(', ')}] of [${expected.join(', ')}]`);
            break;
        }
        await sleep(30000);
    }
    if (!legs.length) {
        log('no CDRs found - nothing to disposition');
        process.exit(1);
    }

    await checkCodes();

    // One write per parent CDR, in answer order; the last agent's
    // disposition wins and the notes collect every agent's entry.
    legs.sort((a, b) => String(a['call-answer-datetime']).localeCompare(String(b['call-answer-datetime'])));
    const byCdr = new Map();
    for (const r of legs) {
        const id = r['call-parent-cdr-id'] || r.id;
        if (!byCdr.has(id)) byCdr.set(id, []);
        byCdr.get(id).push(r);
    }

    let failures = 0;
    for (const [cdrId, rows] of byCdr) {
        const entries = rows.map(r => ({ ext: String(r['call-term-user']), ...flow.dispositions[String(r['call-term-user'])] }));
        const last = entries[entries.length - 1];
        const name = ext => {
            const u = lab.users.find(x => x.ext === ext);
            return u ? `${u.first} ${u.last}` : ext;
        };
        const notes = entries.length === 1 ? last.notes
            : entries.map(e => `${name(e.ext)}: ${e.notes}`).join('\n');
        if (!NO_DELAY) {
            const typing = 20 + Math.floor(Math.random() * 70);
            log(`${name(last.ext)} wrapping up cdr ${cdrId} (${typing}s)`);
            await sleep(typing * 1000);
        }
        const body = {
            'call-disposition': last.disposition.slice(0, 32),
            'call-disposition-reason': last.reason.slice(0, 32),
            'call-disposition-notes': notes,
            'call-disposition-submitted-datetime': new Date().toISOString().replace(/\.\d+Z$/, '+00:00')
        };
        try {
            await client.apiPutJson(`domains/${enc(D)}/cdrs/${enc(cdrId)}`, body);
            log(`cdr ${cdrId}: ${name(last.ext)} -> "${body['call-disposition']}" / "${body['call-disposition-reason']}"`);
        } catch (e) {
            failures++;
            log(`FAILED cdr ${cdrId}: ${describeApiError(e)}`);
        }
    }

    // Read back (the PUT is async) and show the AI fields.
    await sleep(5000);
    for (const cdrId of byCdr.keys()) {
        try {
            const res = await client.apiGet(`domains/${enc(D)}/cdrs/${enc(cdrId)}`);
            const r = Array.isArray(res.data) ? res.data[0] : res.data;
            log(`cdr ${cdrId} now: disposition="${r?.['call-disposition'] || ''}" reason="${r?.['call-disposition-reason'] || ''}" ` +
                `recording-status=${r?.['call-recording-status'] ?? '-'} intelligence-job=${r?.['call-intelligence-job-id'] || '-'} ` +
                `sentiment +${r?.['call-intelligence-percent-positive'] ?? '-'}/~${r?.['call-intelligence-percent-neutral'] ?? '-'}/-${r?.['call-intelligence-percent-negative'] ?? '-'}`);
        } catch (e) {
            log(`could not read back cdr ${cdrId}: ${describeApiError(e)}`);
        }
    }
    process.exit(failures ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
