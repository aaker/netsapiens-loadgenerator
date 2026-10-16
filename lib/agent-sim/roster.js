// Roster shaping (`agent-sim setup`) and undo (`agent-sim restore`).
//
// setup:
//   1. snapshot every queue membership (never overwritten once written);
//   2. pick ~targetAgents users as the active roster, favouring users who are
//      already in several queues;
//   3. give each active agent a home queue plus secondary skills, with deeper
//      skill pools on "strong" queues and thinner ones on "struggling" queues,
//      and remove them from every other queue;
//   4. split the leftover agents into delete / disable / idle (reserve);
//   5. set wrap-up and dispatch priority per membership from the queue profile;
//   6. write the custom away-reason labels.
// The result is roster.json in the domain state dir, which `run` reads.

const fs = require('fs');
const path = require('path');
const { makeRng } = require('./rng');
const { profileFor, profileNameFor, stateDir, CUSTOM_REASONS } = require('./config');

const AGENT_FIELDS = [
    'callqueue-agent-availability-type',
    'callqueue-agent-wrap-up-allowance-seconds',
    'callqueue-agent-dispatch-order-ordinal',
    'callqueue-agent-dispatch-queue-priority-ordinal',
    'limits-max-active-calls-total',
    'auto-answer-enabled',
    'callqueue-agent-answer-confirmation-enabled'
];

// Horizon status tones / icons for the custom labels (callcenter.status.custom)
const DEFAULT_ICON = 'material-symbols:more-horiz';
const DEFAULT_TONE = 'warning';

function snapshotPath(d) { return path.join(stateDir(d), 'roster-snapshot.json'); }
function rosterPath(d) { return path.join(stateDir(d), 'roster.json'); }

function loadRoster(d) {
    const p = rosterPath(d);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Only user agents (user@domain) are simulated; sip: device entries are left alone. */
function isUserAgent(row) {
    const id = row['callqueue-agent-id'] || '';
    return !id.startsWith('sip:') && id.includes('@');
}

function pickBody(row) {
    const body = {};
    for (const f of AGENT_FIELDS) if (row[f] !== undefined && row[f] !== null) body[f] = row[f];
    return body;
}

async function takeSnapshot(d, api, log) {
    const p = snapshotPath(d);
    if (fs.existsSync(p)) {
        log(`Snapshot already exists, keeping it: ${p}`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    const queues = await api.listQueues();
    const agents = await api.listMemberships(queues.map(q => String(q.callqueue)));
    const snapshot = {
        takenAt: new Date().toISOString(),
        server: d.server,
        domain: d.domain,
        queues: queues.map(q => ({ callqueue: String(q.callqueue), description: q.description })),
        agents: agents.map(a => ({
            callqueue: String(a.callqueue),
            'callqueue-agent-id': a['callqueue-agent-id'],
            'callqueue-agent-availability-for-dispatch': a['callqueue-agent-availability-for-dispatch'],
            ...pickBody(a)
        }))
    };
    if (!api.dryRun) {
        fs.writeFileSync(p, JSON.stringify(snapshot, null, 2));
        log(`Snapshot written: ${p} (${snapshot.queues.length} queues, ${snapshot.agents.length} memberships)`);
    } else {
        log(`[dry-run] would write snapshot ${p} (${snapshot.queues.length} queues, ${snapshot.agents.length} memberships)`);
    }
    return snapshot;
}

/**
 * Pure planning step: from the snapshot and config, decide who is active, which
 * queues they cover, and what happens to everyone else.
 */
function planRoster(d, snapshot) {
    const rng = makeRng(`${d.seed}:roster:${d.domain}`);
    const queueIds = snapshot.queues.map(q => q.callqueue);
    const queueNames = Object.fromEntries(snapshot.queues.map(q => [q.callqueue, q.description || q.callqueue]));

    // membership: agentId -> Set(queue)
    const membership = new Map();
    for (const row of snapshot.agents) {
        if (!isUserAgent(row)) continue;
        const id = row['callqueue-agent-id'];
        if (!membership.has(id)) membership.set(id, new Set());
        membership.get(id).add(String(row.callqueue));
    }
    const allAgents = [...membership.keys()].sort();

    const target = Math.min(d.roster.targetAgents, allAgents.length);
    const active = rng.sampleWeighted(allAgents, target, id => membership.get(id).size).sort();
    const activeSet = new Set(active);

    // Skill assignment
    const depth = q => profileFor(d, q).skillDepth ?? 1;
    const assignments = {};
    for (const id of active) {
        const current = membership.get(id);
        const k = Math.max(1, Math.min(queueIds.length, rng.intRange(d.roster.queuesPerAgent)));
        // Existing memberships are 3x as likely, so fewer adds are needed
        const weightOf = q => depth(q) * (current.has(q) ? 3 : 1);
        const picks = rng.sampleWeighted(queueIds, k, weightOf);
        // Home queue: the deepest-weighted pick
        const home = rng.weighted(Object.fromEntries(picks.map(q => [q, weightOf(q)]))) || picks[0];
        assignments[id] = { home, queues: [home, ...picks.filter(q => q !== home)] };
    }

    // Top up queues that ended with too few skilled agents
    const minPer = d.roster.minAgentsPerQueue || 0;
    for (const q of queueIds) {
        const have = active.filter(id => assignments[id].queues.includes(q));
        if (have.length >= minPer) continue;
        const candidates = rng.shuffle(active.filter(id => !assignments[id].queues.includes(q)));
        for (const id of candidates.slice(0, minPer - have.length)) assignments[id].queues.push(q);
    }

    // Extras
    const extras = rng.shuffle(allAgents.filter(id => !activeSet.has(id)));
    const nDelete = Math.round(extras.length * d.roster.extras.deletePct);
    const nDisable = Math.round(extras.length * d.roster.extras.disablePct);
    const deleted = extras.slice(0, nDelete).sort();
    const disabled = extras.slice(nDelete, nDelete + nDisable).sort();
    const idle = extras.slice(nDelete + nDisable).sort();

    // Idle (reserve) and disabled agents keep only a few of their queues, like
    // the active roster, so queue agent counts stay realistic
    const keep = {};
    for (const id of [...idle, ...disabled]) {
        const current = [...membership.get(id)].sort();
        const k = Math.max(1, Math.min(current.length, rng.intRange(d.roster.queuesPerAgent)));
        // Reserves lean towards thin (struggling) queues, where call-ins help most
        const w = idle.includes(id) ? (q => 1 / depth(q)) : depth;
        keep[id] = rng.sampleWeighted(current, k, w).sort();
    }

    // Wrap-up per membership from the queue profile
    const wrapUp = {};
    for (const id of active) {
        for (const q of assignments[id].queues) {
            wrapUp[`${id}|${q}`] = Math.round(rng.range(profileFor(d, q).wrapUpSec || 0));
        }
    }

    return { queueIds, queueNames, membership, active, assignments, deleted, disabled, idle, keep, wrapUp };
}

function summarize(d, plan, log) {
    log(`Roster plan for ${d.domain}: ${plan.active.length} active, ${plan.idle.length} idle (reserve), ` +
        `${plan.disabled.length} disabled, ${plan.deleted.length} deleted`);
    log('  queue   profile      skilled  home  idle  disabled  name');
    for (const q of plan.queueIds) {
        const skilled = plan.active.filter(id => plan.assignments[id].queues.includes(q)).length;
        const home = plan.active.filter(id => plan.assignments[id].home === q).length;
        const idle = plan.idle.filter(id => plan.keep[id].includes(q)).length;
        const dis = plan.disabled.filter(id => plan.keep[id].includes(q)).length;
        log(`  ${q.padEnd(7)} ${profileNameFor(d, q).padEnd(12)} ${String(skilled).padStart(7)} ${String(home).padStart(5)} ` +
            `${String(idle).padStart(5)} ${String(dis).padStart(9)}  ${plan.queueNames[q]}`);
    }
    const multi = plan.active.filter(id => plan.assignments[id].queues.length > 1).length;
    log(`  ${multi}/${plan.active.length} active agents cover more than one queue`);
}

function customSlots(d) {
    return CUSTOM_REASONS.map(slot => {
        const v = d.statuses.custom?.[slot];
        if (!v) return ['', DEFAULT_ICON, DEFAULT_TONE];
        if (typeof v === 'string') return [v, DEFAULT_ICON, DEFAULT_TONE];
        return [v.name || '', v.icon || DEFAULT_ICON, v.tone || DEFAULT_TONE];
    });
}

async function writeLabels(d, api, log) {
    const slots = customSlots(d);
    const jobs = [];
    slots.forEach(([name], i) => {
        if (name) jobs.push(api.setDomainConfiguration(`PORTAL_CALL_QUEUE_STATUS_CUSTOM_${i + 1}`, name));
    });
    jobs.push(api.setDomainSetting('callcenter.status.custom', slots));
    const results = await Promise.all(jobs);
    const failed = results.filter(r => !r.ok);
    for (const f of failed) log(`  label write failed: ${f.error}`);
    log(`Custom status labels: ${slots.map(([n], i) => n && `cust${i + 1}=${n}`).filter(Boolean).join(', ') || '(none)'}`);
}

async function setup(d, api, log, { labelsOnly = false } = {}) {
    if (labelsOnly) return writeLabels(d, api, log);

    const snapshot = await takeSnapshot(d, api, log);
    const plan = planRoster(d, snapshot);
    summarize(d, plan, log);

    // Current memberships (may differ from the snapshot on a re-run)
    const live = (await api.listMemberships(plan.queueIds)).filter(isUserAgent);
    const liveSet = new Set(live.map(r => `${r['callqueue-agent-id']}|${r.callqueue}`));
    const liveRow = new Map(live.map(r => [`${r['callqueue-agent-id']}|${r.callqueue}`, r]));

    const ops = [];
    const result = { added: 0, updated: 0, deleted: 0, disabled: 0, failed: 0 };
    const track = (kind, p) => ops.push(p.then(r => {
        if (r.ok) result[kind]++;
        else { result.failed++; log(`  ${kind} failed: ${r.error}`); }
    }));

    // Active agents: exact skill set, wrap-up and priority
    for (const id of plan.active) {
        const { home, queues } = plan.assignments[id];
        for (const q of queues) {
            const body = {
                'callqueue-agent-availability-type': 'automatic',
                'callqueue-agent-wrap-up-allowance-seconds': plan.wrapUp[`${id}|${q}`],
                'callqueue-agent-dispatch-queue-priority-ordinal': q === home ? 1 : 2
            };
            if (liveSet.has(`${id}|${q}`)) {
                const row = liveRow.get(`${id}|${q}`);
                const same = Object.entries(body).every(([k, v]) => String(row[k]) === String(v));
                if (!same) track('updated', api.updateAgent(q, id, body));
            } else {
                track('added', api.addAgent(q, { 'callqueue-agent-id': id, ...body }));
            }
        }
        for (const q of plan.queueIds) {
            if (!queues.includes(q) && liveSet.has(`${id}|${q}`)) track('deleted', api.deleteAgent(q, id));
        }
    }

    for (const id of plan.deleted) {
        for (const q of plan.queueIds) if (liveSet.has(`${id}|${q}`)) track('deleted', api.deleteAgent(q, id));
    }

    for (const id of [...plan.idle, ...plan.disabled]) {
        for (const q of plan.queueIds) {
            if (liveSet.has(`${id}|${q}`) && !plan.keep[id].includes(q)) track('deleted', api.deleteAgent(q, id));
        }
    }

    for (const id of plan.disabled) {
        for (const q of plan.keep[id]) {
            if (!liveSet.has(`${id}|${q}`)) continue;
            if (liveRow.get(`${id}|${q}`)['callqueue-agent-availability-type'] === 'disabled') continue;
            track('disabled', api.updateAgent(q, id, { 'callqueue-agent-availability-type': 'disabled' }));
        }
    }

    // Idle (reserve) agents keep their memberships but start the day logged out
    for (const id of plan.idle) track('updated', api.agentAction(id, 'all', 'logout'));

    await Promise.all(ops);
    log(`Roster changes: ${JSON.stringify(result)}`);

    await writeLabels(d, api, log);

    const roster = {
        builtAt: new Date().toISOString(),
        domain: d.domain,
        queues: plan.queueIds.map(q => ({ callqueue: q, name: plan.queueNames[q], profile: profileNameFor(d, q) })),
        agents: {}
    };
    for (const id of plan.active) {
        const wrapUp = Object.fromEntries(plan.assignments[id].queues.map(q => [q, plan.wrapUp[`${id}|${q}`]]));
        roster.agents[id] = { role: 'active', home: plan.assignments[id].home, queues: plan.assignments[id].queues, wrapUp };
    }
    for (const id of plan.idle) {
        roster.agents[id] = { role: 'idle', home: null, queues: plan.keep[id] };
    }
    for (const id of plan.disabled) {
        roster.agents[id] = { role: 'disabled', home: null, queues: plan.keep[id] };
    }
    if (!api.dryRun) {
        fs.writeFileSync(rosterPath(d), JSON.stringify(roster, null, 2));
        log(`Roster written: ${rosterPath(d)}`);
    }
    return roster;
}

async function restore(d, api, log) {
    const p = snapshotPath(d);
    if (!fs.existsSync(p)) throw new Error(`No snapshot at ${p}; nothing to restore`);
    const snapshot = JSON.parse(fs.readFileSync(p, 'utf8'));
    const snapKeys = new Set(snapshot.agents.map(a => `${a['callqueue-agent-id']}|${a.callqueue}`));

    const live = await api.listMemberships(snapshot.queues.map(q => q.callqueue));
    const liveRow = new Map(live.map(r => [`${r['callqueue-agent-id']}|${r.callqueue}`, r]));

    const result = { added: 0, updated: 0, deleted: 0, failed: 0 };
    const ops = [];
    const track = (kind, pr) => ops.push(pr.then(r => {
        if (r.ok) result[kind]++;
        else { result.failed++; log(`  ${kind} failed: ${r.error}`); }
    }));

    for (const a of snapshot.agents) {
        const id = a['callqueue-agent-id'];
        const key = `${id}|${a.callqueue}`;
        const body = pickBody(a);
        if (!liveRow.has(key)) {
            track('added', api.addAgent(a.callqueue, { 'callqueue-agent-id': id, ...body }));
        } else {
            const row = liveRow.get(key);
            const same = Object.entries(body).every(([k, v]) => String(row[k]) === String(v));
            if (!same) track('updated', api.updateAgent(a.callqueue, id, body));
        }
    }
    // Memberships setup added that were not in the snapshot
    for (const r of live) {
        if (!isUserAgent(r)) continue;
        const key = `${r['callqueue-agent-id']}|${r.callqueue}`;
        if (!snapKeys.has(key)) track('deleted', api.deleteAgent(String(r.callqueue), r['callqueue-agent-id']));
    }
    await Promise.all(ops);

    // Everyone who was dispatchable when the snapshot was taken logs back in
    const wasAvailable = new Set(snapshot.agents
        .filter(a => a['callqueue-agent-availability-for-dispatch'] === 'available' && isUserAgent(a))
        .map(a => a['callqueue-agent-id']));
    await Promise.all([...wasAvailable].map(id => api.agentAction(id, 'all', 'login')));

    log(`Restore: ${JSON.stringify(result)}, logged in ${wasAvailable.size} agents`);
    log(`Snapshot kept at ${p}; delete it (and roster.json) before running setup on a fresh roster.`);
}

module.exports = { setup, restore, loadRoster, planRoster, isUserAgent, rosterPath, snapshotPath };
