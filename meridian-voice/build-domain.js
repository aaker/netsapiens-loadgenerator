#!/usr/bin/env node
//
// build-domain.js - build (or bring up to date) the Meridian Voice test
// domain described in lab.json, via NetSapiens API v2.
//
//   node meridian-voice/build-domain.js --server <id> [--dry-run] [--skip-avatars]
//
// Creates, in order, and updates anything that already exists (409 -> PUT):
//   - the inbound-carrier connection (shared by every load test; skipped if present)
//   - the domain, and a dial rule chaining its dial plan to <Cloud PBX Features>
//   - users 2001-2003 as Call Center Agents, with call recording, transcription
//     and sentiment (lab.json "recording"), and their avatars
//   - one device per user (device name = extension) with a SIP password
//     derived from the server's API key, so every rebuild gives the same one
//   - queues 4000/4001 (and their system users) with exactly the agents in
//     lab.json, logged in
//   - park 700, conference bridge 800 (no PIN, no prompts)
//   - one DID per call flow, routed to queue 4000
// Then writes lab/devices.csv (gitignored: it holds the SIP passwords), which
// sipp/scripts/manual_test.sh registers.
//
// Run from anywhere; servers.json and .env are read from the repo root.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
process.chdir(REPO);
require('dotenv').config({ path: path.join(REPO, '.env') });
const { loadConfig } = require('../lib/config');
const { ServerApiClient, describeApiError } = require('../lib/nsapi');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_AVATARS = process.argv.includes('--skip-avatars');
const lab = JSON.parse(fs.readFileSync(path.join(__dirname, 'lab.json'), 'utf8'));
const D = lab.domain;
const enc = encodeURIComponent;

const { selectedServer } = loadConfig();
const client = new ServerApiClient(selectedServer);
let failures = 0;

function log(msg) {
    console.log(`[${selectedServer.id}/${D}] ${msg}`);
}

// SIP password for a device: stable per server API key, domain and extension.
function devicePassword(ext) {
    return crypto.createHmac('sha256', selectedServer.apikey)
        .update(`meridian-voice:${D}:${ext}`).digest('base64url').slice(0, 20);
}

// POST `create`; on 409 PUT `update` (or skip when update is null).
async function upsert(label, createPath, body, updatePath, updateBody = body) {
    if (DRY_RUN) {
        log(`DRY RUN ${label}: POST ${createPath} ${JSON.stringify(body)}`);
        return;
    }
    try {
        await client.apiPostJson(createPath, { synchronous: 'yes', ...body });
        log(`created ${label}`);
    } catch (e) {
        if (e?.response?.status !== 409) {
            failures++;
            log(`FAILED ${label}: ${describeApiError(e)}`);
            return;
        }
        if (!updatePath) {
            log(`${label} already exists`);
            return;
        }
        try {
            await client.apiPutJson(updatePath, updateBody);
            log(`updated ${label}`);
        } catch (e2) {
            failures++;
            log(`FAILED updating ${label}: ${describeApiError(e2)}`);
        }
    }
}

async function attempt(label, fn) {
    if (DRY_RUN) {
        log(`DRY RUN ${label}`);
        return;
    }
    try {
        await fn();
        log(label);
    } catch (e) {
        failures++;
        log(`FAILED ${label}: ${describeApiError(e)}`);
    }
}

async function buildDomain() {
    await upsert('inbound-carrier connection', 'connections', {
        domain: process.env.CARRIER_CONNECTION_DOMAIN || '*',
        'connection-orig-match-pattern': 'sip*@inbound-carrier',
        'connection-term-match-pattern': 'sip*@inbound-carrier',
        'dial-plan': 'Inbound DID',
        'dial-policy': 'Permit All',
        'connection-source-ip-checking-enabled': 'no',
        'connection-orig-enabled': 'yes',
        'connection-term-enabled': 'no'
    }, null);

    const domain = {
        description: lab.description,
        reseller: process.env.RESELLER || 'NetSapiens',
        'time-zone': lab.timeZone,
        'area-code': lab.areaCode,
        'caller-id-name': lab.description.slice(0, 15),
        'caller-id-number': lab.mainNumber,
        'caller-id-number-emergency': lab.mainNumber,
        'dial-policy': 'US and Canada',
        'language-token': 'en_US'
    };
    await upsert('domain', 'domains', { domain: D, ...domain }, `domains/${enc(D)}`, domain);

    // The domain's dial plan starts empty: chain it to <Cloud PBX Features> so
    // devices can dial extensions, the park and the bridge (as server.js does).
    const rulesPath = `domains/${enc(D)}/dialplans/${enc(D)}/dialrules`;
    const chainDescription = `Chain to ${D} dial plan`;
    let haveChain = false;
    if (!DRY_RUN) {
        try {
            const res = await client.apiGet(rulesPath);
            haveChain = (res.data || []).some(r => r['dial-rule-description'] === chainDescription);
        } catch (e) {
            log(`could not read dial rules (${describeApiError(e)}), adding the chain rule anyway`);
        }
    }
    if (haveChain) {
        log('dial plan chain rule already exists');
    } else {
        await upsert('dial plan chain rule', rulesPath, {
            'dial-rule-matching-to-uri': '*',
            'dial-rule-matching-from-uri': '*',
            'dial-rule-translation-source-name': '[*]',
            'dial-rule-translation-source-user': '[*]',
            'dial-rule-translation-source-host': '[*]',
            'dial-rule-description': chainDescription,
            'dial-rule-application': '<Cloud PBX Features>',
            'dial-rule-translation-destination-user': '[*]',
            'dial-rule-translation-destination-host': '[*]',
            'dial-rule-translation-destination-scheme': '[*]',
            'dial-rule-translation-source-scheme': '[*]'
        }, null);
    }
}

async function buildUsers() {
    for (const u of lab.users) {
        const user = {
            'name-first-name': u.first,
            'name-last-name': u.last,
            email: `${u.first}.${u.last}@${lab.emailDomain}`.toLowerCase(),
            department: u.department,
            'user-scope': 'Call Center Agent',
            'time-zone': lab.timeZone,
            'recording-configuration': lab.recording
        };
        await upsert(`user ${u.ext} (${u.first} ${u.last})`, `domains/${enc(D)}/users`,
            { user: u.ext, ...user }, `domains/${enc(D)}/users/${enc(u.ext)}`, user);

        const device = {
            'device-sip-registration-password': devicePassword(u.ext),
            'device-sip-nat-traversal': 'automatic'
        };
        await upsert(`device ${u.ext}`, `domains/${enc(D)}/users/${enc(u.ext)}/devices`,
            { device: u.ext, ...device }, `domains/${enc(D)}/users/${enc(u.ext)}/devices/${enc(u.ext)}`, device);

        if (!SKIP_AVATARS && u.avatar) {
            const file = path.join(__dirname, u.avatar);
            await attempt(`avatar ${u.ext} <- ${u.avatar}`,
                () => client.apiFormPut(`domains/${enc(D)}/users/${enc(u.ext)}/avatar`, file));
        }
    }
}

async function buildQueues() {
    for (const q of lab.queues) {
        const queue = {
            description: q.name,
            'callqueue-dispatch-type': 'Round-robin',
            'callqueue-agent-dispatch-timeout-seconds': 30,
            'callqueue-calculate-statistics': 'yes'
        };
        await upsert(`queue ${q.queue} (${q.name})`, `domains/${enc(D)}/callqueues`,
            { callqueue: q.queue, ...queue }, `domains/${enc(D)}/callqueues/${enc(q.queue)}`, queue);
        // The queue's system user, as server.js creates it.
        await upsert(`queue ${q.queue} system user`, `domains/${enc(D)}/users`, {
            user: q.queue,
            'name-first-name': q.name,
            'name-last-name': 'Queue',
            'service-code': 'system-queue',
            'user-scope': 'No Portal',
            'callqueue-max-wait-timeout-minutes': 30
        }, null);

        const agentsPath = `domains/${enc(D)}/callqueues/${enc(q.queue)}/agents`;
        const wanted = new Set(q.agents.map(ext => `${ext}@${D}`));
        if (!DRY_RUN) {
            // Exactly the agents in lab.json: the scripted calls need agent A
            // to be the only one the DID queue rings.
            try {
                const res = await client.apiGet(agentsPath);
                for (const a of res.data || []) {
                    const id = a['callqueue-agent-id'];
                    if (id && !wanted.has(id)) {
                        await attempt(`removed agent ${id} from queue ${q.queue}`,
                            () => client.apiDelete(`${agentsPath}/${enc(id)}`));
                    }
                }
            } catch (e) {
                log(`could not list queue ${q.queue} agents: ${describeApiError(e)}`);
            }
        }
        for (const id of wanted) {
            await upsert(`agent ${id} in queue ${q.queue}`, agentsPath, {
                'callqueue-agent-id': id,
                'callqueue-agent-availability-type': 'automatic'
            }, null);
            await attempt(`logged in ${id} on queue ${q.queue}`,
                () => client.apiPatch(`${agentsPath}/${enc(id)}/login`));
        }
    }
}

async function buildFeatures() {
    await upsert(`park ${lab.park.ext}`, `domains/${enc(D)}/parks`,
        { park: lab.park.ext, description: lab.park.description }, null);

    const conf = {
        'conference-name': lab.conference.name,
        'conference-type': 'dedicated',
        'conference-owner-user': lab.conference.ext,
        'conference-announce-participants-enabled': 'no',
        'conference-request-name-enabled': 'no',
        'conference-require-leader-to-start': 'no'
    };
    await upsert(`conference bridge ${lab.conference.ext}`, `domains/${enc(D)}/conferences`,
        { conference: lab.conference.ext, ...conf },
        `domains/${enc(D)}/conferences/${enc(lab.conference.ext)}`, conf);

    for (const [flow, f] of Object.entries(lab.flows)) {
        const did = {
            'dial-rule-application': 'to-callqueue',
            'dial-rule-translation-destination-user': lab.queues[0].queue,
            'dial-rule-translation-destination-host': D,
            'dial-rule-description': `Meridian Voice ${flow} flow`,
            enabled: 'yes'
        };
        await upsert(`DID ${f.did} (${flow}) -> queue ${lab.queues[0].queue}`, `domains/${enc(D)}/phonenumbers`,
            { phonenumber: f.did, ...did }, `domains/${enc(D)}/phonenumbers/${enc(f.did)}`, did);
    }
}

// The device CSV manual_test.sh registers (SEQUENTIAL, 5-column layout).
function writeDeviceCsv() {
    const dir = path.join(__dirname, 'lab');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'devices.csv');
    const rows = lab.users.map(u =>
        `${u.first} ${u.last};${u.ext};${D};[authentication username=${u.ext} password=${devicePassword(u.ext)}];netsapiens-loadgenerator`);
    fs.writeFileSync(file, ['SEQUENTIAL', ...rows].join('\r\n') + '\r\n', { mode: 0o600 });
    log(`wrote ${path.relative(REPO, file)} (${rows.length} devices)`);
}

async function main() {
    log(`building on ${selectedServer.hostname}${DRY_RUN ? ' (dry run)' : ''}`);
    await buildDomain();
    await buildUsers();
    await buildQueues();
    await buildFeatures();
    if (!DRY_RUN) writeDeviceCsv();
    log(failures ? `done with ${failures} failure(s) - see FAILED lines above` : 'done');
    process.exit(failures ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
