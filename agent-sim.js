#!/usr/bin/env node
// agent-sim: call-center agent behaviour simulator for selected domains.
//
//   node agent-sim.js setup   --server <id> --domain <d> [--dry-run] [--labels-only]
//   node agent-sim.js restore --server <id> --domain <d> [--dry-run]
//   node agent-sim.js run     [--server <id>] [--domain <d>] [--dry-run] [--time-scale N] [--agent user@domain]
//   node agent-sim.js status  --server <id> --domain <d>
//   node agent-sim.js plan    --server <id> --domain <d> [--date YYYY-MM-DD] [--agent user@domain]
//   node agent-sim.js report  --server <id> --domain <d> [--date YYYY-MM-DD]
//   node agent-sim.js codes   --server <id> --domain <d> [--seed]   (disposition / call-reason codes)
//
// Behaviour per domain lives in agent-sim.json (see agent-sim.json.example);
// hostname/apikey come from servers.json (or .env in legacy mode). Run from
// the repository root.

const fs = require('fs');
const path = require('path');
const { loadAgentSimConfig, profileNameFor, stateDir } = require('./lib/agent-sim/config');
const { DomainApi, sleep } = require('./lib/agent-sim/api');
const roster = require('./lib/agent-sim/roster');
const { buildDayPlan } = require('./lib/agent-sim/schedule');
const { DomainEngine } = require('./lib/agent-sim/engine');
const { writeMetrics, outputPath } = require('./lib/agent-sim/metrics');
const { SimClock, wallClock, epochOf, formatForApi, formatLocal } = require('./lib/agent-sim/time');

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) args[key] = true;
            else { args[key] = next; i++; }
        } else {
            args._.push(a);
        }
    }
    return args;
}

function log(...a) {
    console.log(new Date().toISOString(), ...a);
}

function selectDomains(all, args, { requireOne = false } = {}) {
    let list = all;
    if (args.server) list = list.filter(d => d.server === args.server);
    if (args.domain) list = list.filter(d => d.domain === args.domain);
    if (!list.length) throw new Error(`No agent-sim.json entry matches${args.server ? ' --server ' + args.server : ''}${args.domain ? ' --domain ' + args.domain : ''}`);
    if (requireOne && list.length !== 1) throw new Error('This command needs exactly one domain: pass --server and --domain');
    return list;
}

// ---------------------------------------------------------------- status

async function cmdStatus(d) {
    const api = new DomainApi(d, { dryRun: true });
    const queues = await api.listQueues();
    const rows = await api.listMemberships(queues.map(q => String(q.callqueue)));
    const agents = new Set(rows.filter(roster.isUserAgent).map(r => r['callqueue-agent-id']));
    console.log(`${d.server}/${d.domain}: ${queues.length} queues, ${agents.size} unique user agents, ${rows.length} memberships`);
    console.log('queue   profile      members auto manual disabled avail oncall reg  waiting  name');
    for (const q of queues.sort((a, b) => String(a.callqueue).localeCompare(String(b.callqueue)))) {
        const qr = rows.filter(r => String(r.callqueue) === String(q.callqueue));
        const n = f => qr.filter(f).length;
        console.log([
            String(q.callqueue).padEnd(7),
            profileNameFor(d, q.callqueue).padEnd(12),
            String(qr.length).padStart(7),
            String(n(r => r['callqueue-agent-availability-type'] === 'automatic')).padStart(4),
            String(n(r => r['callqueue-agent-availability-type'] === 'manual')).padStart(6),
            String(n(r => r['callqueue-agent-availability-type'] === 'disabled')).padStart(8),
            String(n(r => r['callqueue-agent-availability-for-dispatch'] === 'available')).padStart(5),
            String(n(r => Number(r['active-calls-total-current'] || 0) > 0)).padStart(6),
            String(n(r => r['callqueue-agent-has-registered-devices'] && r['callqueue-agent-has-registered-devices'] !== 'no')).padStart(3),
            String(q['active-queued-calls-total-current'] ?? '-').padStart(8),
            ' ' + (q.description || '')
        ].join(' '));
    }
    const msgs = {};
    for (const r of rows) if (r['status-message']) msgs[r['status-message']] = (msgs[r['status-message']] || 0) + 1;
    if (Object.keys(msgs).length) console.log('status-message counts (rows):', msgs);
    const ros = roster.loadRoster(d);
    if (ros) {
        const roles = {};
        for (const e of Object.values(ros.agents)) roles[e.role] = (roles[e.role] || 0) + 1;
        console.log(`roster.json: ${JSON.stringify(roles)} (built ${ros.builtAt})`);
    } else {
        console.log('roster.json: none yet (run setup)');
    }
}

// ---------------------------------------------------------------- plan

function cmdPlan(d, args) {
    const ros = roster.loadRoster(d);
    if (!ros) throw new Error('No roster.json yet; run setup first');
    const dateKey = args.date || wallClock(Date.now(), d.timezone).dateKey;
    const tz = d.timezone;
    const ids = args.agent ? [args.agent] : Object.keys(ros.agents);
    const perQueueHour = {};
    for (const id of ids) {
        const entry = ros.agents[id];
        const p = buildDayPlan(d, id, entry, dateKey);
        if (args.agent || args.verbose) {
            console.log(`${id} role=${entry?.role} ${p.working ? `shift=${p.shift} ${formatLocal(p.start, tz)}-${formatLocal(p.end, tz)} queues=${p.activeQueues.join(',')}` : (p.absent ? 'ABSENT' : 'off')}`);
            for (const e of p.excursions) {
                console.log(`    ${formatLocal(e.at, tz)}  ${e.kind}${e.reason ? ' ' + e.reason : ''} ${Math.round(e.durationMs / 60000)}m`);
            }
        }
        if (!p.working) continue;
        for (let h = 0; h < 24; h++) {
            const t = epochOf(dateKey, h * 60 + 30, tz);
            if (t < p.start || t >= p.end) continue;
            const away = p.excursions.some(e => t >= e.at && t < e.at + e.durationMs);
            for (const q of p.activeQueues) {
                perQueueHour[q] = perQueueHour[q] || Array(24).fill(0);
                if (!away) perQueueHour[q][h]++;
            }
        }
    }
    if (!args.agent) {
        console.log(`Planned available agents per queue at :30 past each hour, ${dateKey} (${tz}); excludes reserve call-ins and on-call time`);
        const hours = [...Array(24).keys()].filter(h => Object.values(perQueueHour).some(a => a[h]));
        console.log('queue   profile      ' + hours.map(h => String(h).padStart(3)).join(''));
        for (const q of Object.keys(perQueueHour).sort()) {
            console.log(`${q.padEnd(7)} ${profileNameFor(d, q).padEnd(12)} ` + hours.map(h => String(perQueueHour[q][h]).padStart(3)).join(''));
        }
    }
}

// ---------------------------------------------------------------- report

async function cmdReport(d, args) {
    const api = new DomainApi(d, { dryRun: true });
    const tz = d.timezone;
    const dateKey = args.date || wallClock(Date.now(), tz).dateKey;
    const start = epochOf(dateKey, 0, tz);
    const end = Math.min(Date.now(), epochOf(dateKey, 24 * 60, tz) - 1000);
    const window = { 'datetime-start': formatForApi(start, tz), 'datetime-end': formatForApi(end, tz) };

    const perQueue = await api.stats('perQueue', {
        ...window, fields: 'VOL,CH,AC,AR,SL,AWT,AHT,VM,FWD', sla: d.sla, unit: 'seconds'
    }).catch(e => ({ error: e.message }));
    console.log(`Queue performance ${dateKey} (SL ${d.sla}s):`);
    if (perQueue.error) console.log('  ', perQueue.error);
    else {
        console.log('queue   profile         VOL    CH    AC    AR%    SL%   AWT(s)  AHT');
        for (const [q, v] of Object.entries(perQueue).sort()) {
            const g = k => v[k] ?? v[Object.keys(v).find(x => x.toUpperCase() === k)] ?? '';
            console.log(`${q.padEnd(7)} ${profileNameFor(d, q).padEnd(12)} ` +
                [g('VOL'), g('CH'), g('AC'), g('AR'), g('SL'), g('AWT'), g('AHT')].map(x => String(typeof x === 'number' ? Math.round(x * 10) / 10 : x).padStart(6)).join(''));
        }
    }

    const log = await api.stats('agentLog', window).catch(e => ({ error: e.message }));
    if (log.error) {
        console.log('agentLog:', log.error);
        return;
    }
    const totals = {};
    let n = 0;
    for (const v of Object.values(log)) {
        n++;
        for (const [k, m] of Object.entries(v)) totals[k] = (totals[k] || 0) + Number(m || 0);
    }
    console.log(`\nAgent time in status ${dateKey} (${n} agents, hours):`);
    for (const [k, m] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(40)} ${(m / 60).toFixed(1)}`);
    }
}

// ---------------------------------------------------------------- codes

async function cmdCodes(d, args) {
    const { Dispositions } = require('./lib/agent-sim/dispositions');
    const api = new DomainApi(d, { dryRun: !!args['dry-run'] || d.dryRun, log });
    const disp = new Dispositions(d, api, { log });
    if (args.seed) disp.cfg.seedCodes = true;
    await disp._ensureCodes();
    const c = disp.codes;
    console.log(`Codes for ${d.domain} from ${c.source}:`);
    console.log('  dispositions:', c.dispositions.map(x => `${x.name} [${x.cls}]`).join(', '));
    if (c.reasonsByDisposition) {
        for (const [k, v] of Object.entries(c.reasonsByDisposition)) console.log(`  reasons for ${k}:`, v.map(x => x.name).join(', ') || '(none)');
    } else {
        console.log('  reasons:', c.reasons.map(x => x.name).join(', ') || '(none)');
    }
    if (c.source === 'config') {
        console.log('  (no codes on the server; --seed creates the default set when /callcenter-codes is enabled)');
    }
}

// ---------------------------------------------------------------- run

async function cmdRun(domains, args) {
    const scale = Number(args['time-scale'] || 1);
    const engines = [];
    for (const d of domains) {
        const dryRun = !!args['dry-run'] || d.dryRun;
        const api = new DomainApi(d, { dryRun, log });
        const clock = new SimClock(scale);
        const extensions = [];
        try {
            const { Dispositions } = require('./lib/agent-sim/dispositions');
            if (d.dispositions && d.dispositions.enabled) extensions.push(new Dispositions(d, api, { log }));
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
        const engine = new DomainEngine(d, api, clock, { log, extensions });
        if (args.agent) {
            const only = engine.roster.agents[args.agent];
            if (!only) throw new Error(`${args.agent} is not in roster.json for ${d.domain}`);
            engine.roster.agents = { [args.agent]: only };
        }
        engines.push(engine);
        log(`[${engine.tag}] starting: ${Object.keys(engine.roster.agents).length} agents, tz=${d.timezone}` +
            `${dryRun ? ', DRY RUN' : ''}${scale !== 1 ? `, time-scale ${scale}x` : ''}`);
    }

    const runDir = path.join(process.cwd(), 'state', 'agent-sim');
    fs.mkdirSync(runDir, { recursive: true });
    const heartbeat = path.join(runDir, 'heartbeat');
    fs.writeFileSync(path.join(runDir, 'agent-sim.pid'), String(process.pid));

    let stopping = false;
    const stop = sig => {
        if (stopping) return;
        stopping = true;
        log(`${sig} received, saving state and exiting`);
        for (const e of engines) e.shutdown();
        process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));

    // Observe before acting, so on-call agents are not pulled mid-call
    await Promise.all(engines.map(e => e.reconcile()));

    const tickMs = Math.min(...domains.map(d => d.engine.tickSec)) * 1000;
    const reconcileMs = Math.min(...domains.map(d => d.engine.reconcileSec)) * 1000;
    let lastReconcile = Date.now();
    let reconciling = false;
    let metricsWarned = false;

    while (!stopping) {
        for (const e of engines) {
            try {
                e.tick();
            } catch (err) {
                log(`[${e.tag}] tick error: ${err.stack || err.message}`);
            }
        }
        if (!reconciling && Date.now() - lastReconcile >= reconcileMs) {
            reconciling = true;
            lastReconcile = Date.now();
            Promise.all(engines.map(e => e.reconcile()))
                .then(() => {
                    if (!writeMetrics(engines.map(e => e.snapshotMetrics())) && !metricsWarned) {
                        metricsWarned = true;
                        log(`metrics: ${path.dirname(outputPath())} does not exist; not writing agent_sim.prom`);
                    }
                })
                .catch(err => log(`reconcile error: ${err.message}`))
                .finally(() => { reconciling = false; });
        }
        fs.writeFileSync(heartbeat, String(Math.floor(Date.now() / 1000)));
        await sleep(tickMs);
    }
}

// ---------------------------------------------------------------- main

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (!cmd || args.help) {
        const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
        const header = lines.slice(0, lines.findIndex(l => !l.startsWith('//')));
        console.log(header.map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exit(cmd ? 0 : 1);
    }
    const all = loadAgentSimConfig(args.config);

    switch (cmd) {
        case 'setup': {
            const [d] = selectDomains(all, args, { requireOne: true });
            const api = new DomainApi(d, { dryRun: !!args['dry-run'] || d.dryRun, log });
            await roster.setup(d, api, log, { labelsOnly: !!args['labels-only'] });
            break;
        }
        case 'restore': {
            const [d] = selectDomains(all, args, { requireOne: true });
            const api = new DomainApi(d, { dryRun: !!args['dry-run'] || d.dryRun, log });
            await roster.restore(d, api, log);
            break;
        }
        case 'status':
            for (const d of selectDomains(all, args)) await cmdStatus(d);
            break;
        case 'plan':
            cmdPlan(selectDomains(all, args, { requireOne: true })[0], args);
            break;
        case 'report':
            for (const d of selectDomains(all, args)) await cmdReport(d, args);
            break;
        case 'codes':
            await cmdCodes(selectDomains(all, args, { requireOne: true })[0], args);
            break;
        case 'run':
            await cmdRun(selectDomains(all, args), args);
            break;
        default:
            throw new Error(`Unknown command "${cmd}"`);
    }
}

main().catch(err => {
    console.error(`agent-sim: ${err.message}`);
    if (process.env.API_DEBUG === '1') console.error(err.stack);
    process.exit(1);
});
