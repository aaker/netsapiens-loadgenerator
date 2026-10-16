// Post-call wrap-up: after a simulated agent finishes a queue call, write a
// disposition, a call reason and (sometimes) a note onto the call's CDR.
//
//   find calls : GET /domains/{d}/cdrs (recent window), keep rows whose
//                call-through-user is one of the domain's queues and whose
//                call-term-user is an agent in the roster, answered, and not
//                yet dispositioned;
//   write      : PUT /domains/{d}/cdrs/{call-parent-cdr-id}
//                {call-disposition, call-disposition-reason,
//                 call-disposition-notes, call-disposition-submitted-datetime}
//
// The API does not validate disposition/reason against configured codes, so
// codes come from /callcenter-codes when that feature is on, else the legacy
// /dispositions list, else the names in agent-sim.json.
//
// Runs as a DomainEngine extension (onReconcile + onTick).

const fs = require('fs');
const path = require('path');
const { makeRng } = require('./rng');
const { stateDir, profileFor } = require('./config');
const { formatForApi } = require('./time');

const enc = encodeURIComponent;
const MIN = 60000;

const DEFAULTS = {
    enabled: false,
    // Share of answered queue calls that get a disposition at all
    pct: 0.85,
    // Seconds after hangup the agent submits; "late" ones go in up to lateMaxMin later
    delaySec: [5, 45],
    latePct: 0.1,
    lateMaxMin: 10,
    reasonPct: 0.9,
    notesPct: 0.4,
    // Codes to use when the server has none configured (name -> weight)
    fallback: {
        dispositions: { Resolved: 6, 'Follow-up Required': 2, 'Callback Scheduled': 1, Escalated: 1, 'Not Resolved': 1, Transferred: 1 },
        reasons: { 'Billing Question': 3, 'Technical Support': 4, 'Sales Inquiry': 2, 'Account Change': 2, 'Order Status': 2, Complaint: 1 }
    },
    // Optional explicit weights by code name; others default to 1
    weights: {},
    // Codes treated as negative when the server gives no classification
    negativeNames: ['Not Resolved', 'Escalated', 'Follow-up Required', 'Complaint', 'Abandoned'],
    lookbackMin: 30,
    refreshCodesMin: 60,
    // Create the server's default code set (POST /callcenter-codes/seed) if empty
    seedCodes: false
};

const NOTES = {
    positive: [
        'Caller issue resolved on first contact.',
        'Walked {caller} through the steps, confirmed working.',
        'Answered question about {reason}; no further action needed.',
        'Customer satisfied, closed out.',
        'Updated account details as requested.'
    ],
    negative: [
        'Could not resolve on this call, escalating to tier 2.',
        '{caller} frustrated with wait time; promised callback.',
        'Needs follow-up: waiting on info from billing.',
        'Issue persists after troubleshooting, ticket opened.',
        'Transferred after long hold; caller asked for supervisor.'
    ],
    neutral: [
        'Left details in account notes.',
        'Caller will call back after checking with their team.',
        'Provided information on {reason}.',
        'General inquiry, sent follow-up email.'
    ]
};

class Dispositions {
    constructor(d, api, { log } = {}) {
        this.name = 'dispositions';
        this.d = d;
        this.cfg = { ...DEFAULTS, ...(d.dispositions || {}), fallback: { ...DEFAULTS.fallback, ...(d.dispositions?.fallback || {}) } };
        this.api = api;
        this.log = (...a) => log(`[${d.server}/${d.domain}] dispositions:`, ...a);
        this.rng = makeRng(`${d.seed}:dispositions:${Date.now()}`);
        this.codes = null;
        this.codesAt = 0;
        this.pending = []; // {cdrId, agentId, queue, dueAt, body}
        this.statePath = path.join(stateDir(d), 'dispositions-seen.json');
        this.seen = this._loadSeen();
        this.counters = {};
    }

    _loadSeen() {
        try {
            return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        } catch (e) {
            return {};
        }
    }

    _saveSeen() {
        if (this.api.dryRun) return;
        const cutoff = Date.now() - 6 * 60 * MIN;
        for (const [k, t] of Object.entries(this.seen)) if (t < cutoff) delete this.seen[k];
        fs.writeFileSync(this.statePath, JSON.stringify(this.seen));
    }

    _count(k) {
        this.counters[k] = (this.counters[k] || 0) + 1;
    }

    // ------------------------------------------------------------ codes

    async _loadCodes() {
        const client = this.api.client;
        const dom = enc(this.d.domain);
        const classify = (name, cls) => {
            if (cls && cls !== 'none') return cls;
            return this.cfg.negativeNames.includes(name) ? 'negative' : 'positive';
        };

        // 1. callcenter-codes (feature flag call_center_reports)
        try {
            const get = type => client.apiGet(`domains/${dom}/callcenter-codes`, { type, active: 'yes' }).then(r => r.data || []);
            let [disp, reasons] = await Promise.all([get('disposition'), get('call-reason')]);
            if (!disp.length && !reasons.length && this.cfg.seedCodes && !this.api.dryRun) {
                await client.apiPostJson(`domains/${dom}/callcenter-codes/seed`, {});
                [disp, reasons] = await Promise.all([get('disposition'), get('call-reason')]);
                this.log(`seeded default codes (${disp.length} dispositions, ${reasons.length} reasons)`);
            }
            const usable = c => c.direction !== 'outbound' && c['system-applied'] !== 'yes';
            disp = disp.filter(usable);
            reasons = reasons.filter(usable);
            if (disp.length) {
                return {
                    source: 'callcenter-codes',
                    dispositions: disp.map(c => ({ name: c.name, cls: classify(c.name, c.classification) })),
                    reasons: reasons.map(c => ({ name: c.name })),
                    reasonsByDisposition: null
                };
            }
        } catch (e) {
            if (e?.response?.status !== 404) this.log(`callcenter-codes read failed: ${e.message}`);
        }

        // 2. legacy disposition_config (disposition + reason pairs)
        try {
            const res = await client.apiGet(`domains/${dom}/dispositions`, { limit: 500 });
            const rows = (Array.isArray(res.data) ? res.data : []).filter(r => !r.disposition_type || /inbound/i.test(r.disposition_type));
            if (rows.length) {
                const byDisp = {};
                for (const r of rows) {
                    byDisp[r.disposition] = byDisp[r.disposition] || [];
                    if (r.reason) byDisp[r.disposition].push({ name: r.reason });
                }
                return {
                    source: 'dispositions',
                    dispositions: Object.keys(byDisp).map(n => ({ name: n, cls: classify(n) })),
                    reasons: [],
                    reasonsByDisposition: byDisp
                };
            }
        } catch (e) {
            if (e?.response?.status !== 404) this.log(`dispositions read failed: ${e.message}`);
        }

        // 3. config fallback
        return {
            source: 'config',
            dispositions: Object.keys(this.cfg.fallback.dispositions).map(n => ({ name: n, cls: classify(n) })),
            reasons: Object.keys(this.cfg.fallback.reasons).map(n => ({ name: n })),
            reasonsByDisposition: null,
            fallbackWeights: { ...this.cfg.fallback.dispositions, ...this.cfg.fallback.reasons }
        };
    }

    async _ensureCodes() {
        if (this.codes && Date.now() - this.codesAt < this.cfg.refreshCodesMin * MIN) return;
        const prev = this.codes?.source;
        this.codes = await this._loadCodes();
        this.codesAt = Date.now();
        if (prev !== this.codes.source) {
            this.log(`using ${this.codes.dispositions.length} dispositions / ${this.codes.reasons.length || Object.keys(this.codes.reasonsByDisposition || {}).length} reasons from ${this.codes.source}`);
        }
    }

    _weight(name) {
        return this.cfg.weights[name] ?? this.codes.fallbackWeights?.[name] ?? 1;
    }

    /** Pick disposition/reason/notes; struggling queues skew negative via profile.negativeBias */
    _choose(queue, callerName) {
        const bias = profileFor(this.d, queue).negativeBias ?? 1;
        const disp = this.rng.weighted(Object.fromEntries(this.codes.dispositions.map(c =>
            [c.name, this._weight(c.name) * (c.cls === 'negative' ? bias : 1)])));
        const cls = this.codes.dispositions.find(c => c.name === disp)?.cls || 'neutral';
        let reason = null;
        if (this.rng.chance(this.cfg.reasonPct)) {
            const pool = this.codes.reasonsByDisposition ? (this.codes.reasonsByDisposition[disp] || []) : this.codes.reasons;
            if (pool.length) reason = this.rng.weighted(Object.fromEntries(pool.map(c => [c.name, this._weight(c.name)])));
        }
        let notes = null;
        if (this.rng.chance(this.cfg.notesPct)) {
            const tpl = this.rng.pick(NOTES[cls] || NOTES.neutral);
            notes = tpl.replace('{caller}', callerName || 'caller').replace('{reason}', (reason || 'their account').toLowerCase());
        }
        return { disp, reason, notes };
    }

    // ------------------------------------------------------------ discovery

    async _recentQueueCalls(now) {
        const tz = this.d.timezone;
        const params = {
            'datetime-start': formatForApi(now - this.cfg.lookbackMin * MIN, tz),
            'datetime-end': formatForApi(now + MIN, tz),
            limit: 100,
            start: 0
        };
        const rows = [];
        for (let page = 0; page < 20; page++) {
            const res = await this.api.client.apiGet(`domains/${enc(this.d.domain)}/cdrs`, { ...params, start: page * 100 });
            const batch = Array.isArray(res.data) ? res.data : [];
            rows.push(...batch);
            if (batch.length < 100) break;
        }
        return rows;
    }

    async onReconcile(engine, now) {
        await this._ensureCodes();
        const queues = new Set(engine.roster.queues.map(q => String(q.callqueue)));
        const agents = engine.roster.agents;
        let rows;
        try {
            rows = await this._recentQueueCalls(now);
        } catch (e) {
            this.log(`CDR read failed: ${e.message}`);
            return;
        }
        let found = 0;
        for (const r of rows) {
            const cdrId = r['call-parent-cdr-id'] || r.id;
            if (!cdrId || this.seen[cdrId]) continue;
            const queue = String(r['call-through-user'] || '');
            const agentId = `${r['call-term-user']}@${this.d.domain}`;
            if (!queues.has(queue) || !agents[agentId]) continue;
            if (!r['call-answer-datetime'] || !r['call-disconnect-datetime']) continue;
            if (r['call-disposition']) {
                this.seen[cdrId] = Date.now();
                continue;
            }
            this.seen[cdrId] = Date.now();
            found++;
            if (!this.rng.chance(this.cfg.pct)) {
                this._count('skipped');
                continue;
            }
            const hangup = Date.parse(r['call-disconnect-datetime']) || now;
            const wrap = (agents[agentId].wrapUp || {})[queue];
            const delayRange = wrap ? [Math.min(this.cfg.delaySec[0], wrap), Math.max(wrap, this.cfg.delaySec[0])] : this.cfg.delaySec;
            let dueAt = hangup + this.rng.range(delayRange) * 1000;
            if (this.rng.chance(this.cfg.latePct)) dueAt += this.rng.next() * this.cfg.lateMaxMin * MIN;
            const { disp, reason, notes } = this._choose(queue, r['call-orig-from-name']);
            this.pending.push({ cdrId, agentId, queue, dueAt: Math.max(dueAt, Date.now()), disp, reason, notes });
        }
        if (found) this.log(`${found} new answered queue calls, ${this.pending.length} pending`);
        this._saveSeen();
    }

    onTick(engine, now) {
        if (!this.pending.length) return;
        const due = this.pending.filter(p => p.dueAt <= Date.now());
        if (!due.length) return;
        this.pending = this.pending.filter(p => p.dueAt > Date.now());
        for (const p of due) {
            const body = {
                'call-disposition': p.disp.slice(0, 32),
                'call-disposition-submitted-datetime': new Date().toISOString().replace(/\.\d+Z$/, '+00:00')
            };
            if (p.reason) body['call-disposition-reason'] = p.reason.slice(0, 32);
            if (p.notes) body['call-disposition-notes'] = p.notes;
            const path_ = `domains/${enc(this.d.domain)}/cdrs/${enc(p.cdrId)}`;
            this.api.write(`disposition ${p.agentId} cdr=${p.cdrId} q=${p.queue} "${p.disp}"${p.reason ? ' / ' + p.reason : ''}`, null,
                () => this.api.client.apiPutJson(path_, body))
                .then(res => {
                    this._count(res.ok ? `written_${this._cls(p.disp)}` : 'failed');
                    if (!res.ok) this.log(`cdr ${p.cdrId}: ${res.error}`);
                });
        }
    }

    _cls(name) {
        return this.codes?.dispositions.find(c => c.name === name)?.cls || 'neutral';
    }

    metrics() {
        return [{
            name: 'agentsim_dispositions_total',
            type: 'counter',
            help: 'Post-call dispositions by result (written_<classification>, skipped, failed)',
            samples: Object.entries(this.counters).map(([result, value]) => ({ labels: { result }, value }))
        }, {
            name: 'agentsim_dispositions_pending',
            type: 'gauge',
            help: 'Dispositions waiting for their wrap-up delay',
            samples: [{ labels: {}, value: this.pending.length }]
        }];
    }
}

module.exports = { Dispositions, DISPOSITION_DEFAULTS: DEFAULTS };
