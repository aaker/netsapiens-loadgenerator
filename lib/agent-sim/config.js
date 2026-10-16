// agent-sim configuration: agent-sim.json (per-domain behaviour) merged over
// DEFAULTS, plus the API hostname/apikey resolved from servers.json (or .env in
// legacy single-server mode). Both files are read from the working directory,
// the same convention lib/config.js uses.

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BUILT_IN_REASONS = ['Break', 'Lunch', 'Meeting', 'Web', 'Other', 'Manual-unavail'];
const CUSTOM_REASONS = ['cust1', 'cust2', 'cust3', 'cust4', 'cust5', 'cust6', 'cust7', 'cust8'];

const DEFAULTS = {
    timezone: 'US/Arizona',
    seed: 1,
    dryRun: false,
    sla: 20,
    roster: {
        targetAgents: 80,
        queuesPerAgent: [1, 4],
        minAgentsPerQueue: 3,
        extras: { deletePct: 0.6, disablePct: 0.2, idlePct: 0.2 },
        wrapUpReroll: false
    },
    workday: {
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        weekendStaffingPct: 0.15,
        shifts: [
            { name: 'early', start: '07:00', end: '15:30', pct: 0.35 },
            { name: 'core', start: '08:30', end: '17:00', pct: 0.45 },
            { name: 'late', start: '11:00', end: '19:30', pct: 0.20 }
        ],
        startJitterMin: [-10, 20],
        endJitterMin: [-15, 30],
        absenteeismPct: 0.06,
        lunch: { window: ['11:00', '14:00'], durationMin: [30, 89], minShiftHours: 6 },
        breaks: { count: [2, 2], durationMin: [10, 15] },
        minGapMin: 15
    },
    statuses: {
        weights: { Break: 4, Meeting: 2, Web: 1, Other: 1, 'Manual-unavail': 1, cust1: 2, cust2: 1 },
        custom: { cust1: 'Training', cust2: 'Coaching', cust3: 'Callback Work' },
        randomAwayPerHour: 0.4,
        randomAwayMin: [5, 20],
        minAwayMin: 5,
        onecallPct: 0.03,
        onecallMin: [5, 20],
        manualOfflinePct: 0.03,
        manualOfflineMin: [5, 25],
        deferWhileOnCall: true,
        maxDeferMin: 15
    },
    profiles: {
        strong: { staffing: 1.0, skillDepth: 1.5, wrapUpSec: [5, 15], awayMultiplier: 0.6, negativeBias: 0.5 },
        normal: { staffing: 0.7, skillDepth: 1.0, wrapUpSec: [10, 40], awayMultiplier: 1.0, negativeBias: 1.0 },
        struggling: { staffing: 0.3, skillDepth: 0.5, wrapUpSec: [30, 90], awayMultiplier: 1.8, negativeBias: 2.5 }
    },
    queues: { default: 'normal' },
    reactive: {
        enabled: true,
        waitingThreshold: 4,
        pullReserve: true,
        reserveMin: [30, 90],
        maxReservePerQueue: 3,
        shortenBreaks: true,
        cooldownMin: 10
    },
    drift: {
        relogDelaySec: [30, 180],
        graceSec: 90
    },
    callBoost: {
        enabled: false,
        extraPeakCps: 0.3,
        talkSec: [40, 85],
        transport: 'u1',
        queueWeights: {}
    },
    dispositions: {
        enabled: false
    },
    engine: {
        tickSec: 5,
        reconcileSec: 60,
        concurrency: 4,
        perAgentSpacingMs: 1500,
        verifySamplePct: 0.1
    }
};

function isObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge, arrays and scalars from `over` replace `base`. */
function merge(base, over) {
    if (!isObject(over)) return over === undefined ? base : over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
    }
    return out;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`Failed to read ${file}: ${e.message}`);
    }
}

/** Every server known to the load generator, keyed by id. */
function loadServers() {
    const serversJson = path.join(process.cwd(), 'servers.json');
    if (fs.existsSync(serversJson)) {
        const raw = readJson(serversJson);
        const map = {};
        for (const s of raw.servers || []) map[s.id] = s;
        return map;
    }
    if (process.env.TARGET_SERVER && process.env.APIKEY) {
        return {
            default: {
                id: 'default',
                hostname: process.env.TARGET_SERVER,
                sasHostname: process.env.SAS_SERVER,
                apikey: process.env.APIKEY
            }
        };
    }
    throw new Error('No servers.json and no TARGET_SERVER/APIKEY in .env');
}

function validateDomain(d) {
    const errors = [];
    if (!d.server) errors.push('missing "server"');
    if (!d.domain) errors.push('missing "domain"');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: d.timezone });
    } catch (e) {
        errors.push(`invalid timezone "${d.timezone}"`);
    }
    const shiftPct = (d.workday.shifts || []).reduce((s, x) => s + (x.pct || 0), 0);
    if (!d.workday.shifts?.length || shiftPct <= 0) errors.push('workday.shifts must have at least one shift with pct > 0');
    const allowed = new Set([...BUILT_IN_REASONS, ...CUSTOM_REASONS]);
    for (const r of Object.keys(d.statuses.weights || {})) {
        if (!allowed.has(r)) errors.push(`statuses.weights: unknown reason "${r}" (case-sensitive; allowed: ${[...allowed].join(', ')})`);
    }
    for (const r of Object.keys(d.statuses.custom || {})) {
        if (!CUSTOM_REASONS.includes(r)) errors.push(`statuses.custom: "${r}" must be one of cust1..cust8`);
    }
    for (const [q, p] of Object.entries(d.queues || {})) {
        if (!d.profiles[p]) errors.push(`queues.${q}: unknown profile "${p}"`);
    }
    const ex = d.roster.extras;
    const exSum = (ex.deletePct || 0) + (ex.disablePct || 0) + (ex.idlePct || 0);
    if (Math.abs(exSum - 1) > 0.001) errors.push(`roster.extras percentages must add up to 1 (got ${exSum})`);
    if (errors.length) throw new Error(`agent-sim config for ${d.server}/${d.domain}: ${errors.join('; ')}`);
}

/**
 * Load agent-sim.json and return the fully-merged domain entries, each with
 * its resolved `serverConfig` ({id, hostname, apikey, sasHostname}).
 */
function loadAgentSimConfig(file) {
    const cfgPath = file || path.join(process.cwd(), 'agent-sim.json');
    if (!fs.existsSync(cfgPath)) {
        throw new Error(`${cfgPath} not found. Copy agent-sim.json.example to agent-sim.json and edit it.`);
    }
    const raw = readJson(cfgPath);
    const globalDefaults = merge(DEFAULTS, raw.defaults || {});
    const servers = loadServers();

    return (raw.domains || []).map(entry => {
        const d = merge(globalDefaults, entry);
        // Profiles and queue mappings replace rather than merge key-by-key when
        // given, apart from the built-in profile names staying available
        d.profiles = { ...globalDefaults.profiles, ...(entry.profiles || {}) };
        // Maps that describe a set (which reasons, which labels, which queues)
        // replace the defaults outright, so a reason can be dropped
        if (entry.statuses?.weights) d.statuses.weights = { ...entry.statuses.weights };
        if (entry.statuses?.custom) d.statuses.custom = { ...entry.statuses.custom };
        if (entry.callBoost?.queueWeights) d.callBoost.queueWeights = { ...entry.callBoost.queueWeights };
        if (entry.queues) d.queues = { default: globalDefaults.queues.default || 'normal', ...entry.queues };
        validateDomain(d);
        const server = servers[d.server];
        if (!server) throw new Error(`agent-sim: server "${d.server}" not found (available: ${Object.keys(servers).join(', ')})`);
        if (!server.hostname || !server.apikey) throw new Error(`agent-sim: server "${d.server}" has no hostname/apikey`);
        d.serverConfig = { id: server.id, hostname: server.hostname, apikey: server.apikey, sasHostname: server.sasHostname };
        return d;
    });
}

/** Profile name for a queue (falls back to queues.default, then "normal"). */
function profileNameFor(d, queue) {
    return d.queues[String(queue)] || d.queues.default || 'normal';
}

function profileFor(d, queue) {
    return d.profiles[profileNameFor(d, queue)] || DEFAULTS.profiles.normal;
}

/** Per-domain state directory: state/agent-sim/<server>/<domain>/ */
function stateDir(d) {
    const dir = path.join(process.cwd(), 'state', 'agent-sim', d.server, d.domain);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    DEFAULTS,
    BUILT_IN_REASONS,
    CUSTOM_REASONS,
    loadAgentSimConfig,
    profileNameFor,
    profileFor,
    stateDir,
    merge
};
