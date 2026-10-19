// The agent-sim daemon for one domain: per-agent state machines driven by day
// plans, a reconcile loop against the live API, reactive staffing, call boost
// launches and state persistence.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildDayPlan } = require('./schedule');
const { loadRoster } = require('./roster');
const { stateDir, profileFor } = require('./config');
const { wallClock, formatLocal } = require('./time');
const { makeRng } = require('./rng');

const MIN = 60000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHORTENABLE = new Set(['Break', 'Other', 'Web', 'Manual-unavail']);

class DomainEngine {
    constructor(d, api, clock, { log, extensions = [] } = {}) {
        this.d = d;
        this.api = api;
        this.clock = clock;
        this.tag = `${d.server}/${d.domain}`;
        this.log = (...a) => log(`[${this.tag}]`, ...a);
        this.rng = makeRng(`${d.seed}:runtime:${Date.now()}`);
        this.roster = loadRoster(d);
        if (!this.roster) throw new Error(`No roster for ${this.tag}. Run: node agent-sim.js setup --server ${d.server} --domain ${d.domain}`);
        this.statePath = path.join(stateDir(d), 'state.json');
        this.state = this._loadState();
        this.plans = {};
        this.planDate = null;
        this.observed = { agents: {}, queues: {}, at: 0 };
        this.counters = { drift: {}, reactive: {} };
        this.dirty = false;
        this.lastSave = 0;
        this.lastReactive = {};
        this.lastBoostSlot = null;
        this.extensions = extensions; // objects with optional onReconcile(engine, now), onTick(engine, now)
    }

    // ------------------------------------------------------------ persistence

    _loadState() {
        try {
            const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            if (!s || !s.agents) return { agents: {} };
            // Older state files tracked excursions by index
            for (const a of Object.values(s.agents)) {
                if ('excIdx' in a) {
                    if (a.lastExcAt == null) a.lastExcAt = a.mode === 'away' ? (a.since || 0) : 0;
                    delete a.excIdx;
                }
                if (a.mode === 'away' && a.reason === 'Lunch') a.lunchTaken = true;
            }
            return s;
        } catch (e) {
            return { agents: {} };
        }
    }

    _save(force = false) {
        if (this.api.dryRun) return;
        const now = Date.now();
        if (!force && (!this.dirty || now - this.lastSave < 10000)) return;
        const tmp = `${this.statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, this.statePath);
        this.dirty = false;
        this.lastSave = now;
    }

    agentState(id) {
        if (!this.state.agents[id]) this.state.agents[id] = { mode: 'unknown', lastExcAt: 0 };
        return this.state.agents[id];
    }

    // ------------------------------------------------------------ plans

    _ensurePlans(now) {
        const dateKey = wallClock(now, this.d.timezone).dateKey;
        if (dateKey === this.planDate) return;
        this.planDate = dateKey;
        const newDay = this.state.dateKey !== dateKey;
        let working = 0, absent = 0;
        for (const [id, entry] of Object.entries(this.roster.agents)) {
            const plan = buildDayPlan(this.d, id, entry, dateKey);
            this.plans[id] = plan;
            if (plan.working) working++;
            if (plan.absent) absent++;
            if (newDay) {
                const s = this.agentState(id);
                s.lastExcAt = 0;
                s.lunchTaken = false;
                s.reserveUntil = null;
            }
        }
        this.state.dateKey = dateKey;
        this.dirty = true;
        this.log(`Day plan ${dateKey}: ${working} agents working, ${absent} absent, ` +
            `${Object.keys(this.roster.agents).length - working - absent} off`);
        if (newDay && this.d.roster.wrapUpReroll) this._rerollWrapUp(dateKey);
    }

    _rerollWrapUp(dateKey) {
        const rng = makeRng(`${this.d.seed}:wrapup:${dateKey}`);
        for (const [id, entry] of Object.entries(this.roster.agents)) {
            if (entry.role !== 'active') continue;
            for (const q of entry.queues) {
                const sec = Math.round(rng.range(profileFor(this.d, q).wrapUpSec || 0));
                this.api.updateAgent(q, id, { 'callqueue-agent-wrap-up-allowance-seconds': sec });
            }
        }
    }

    /** Agent's queues for the current shift (normal or reserve call-in). */
    _queuesFor(id, s, now) {
        const plan = this.plans[id];
        const inShift = plan && plan.working && now >= plan.start && now < plan.end;
        if (inShift) return plan.activeQueues;
        if (s.reserveUntil && now < s.reserveUntil) return s.reserveQueues || [];
        return [];
    }

    _onCall(id) {
        return !!this.observed.agents[id]?.onCall;
    }

    // ------------------------------------------------------------ transitions

    async _transition(id, s, mode, { reason = null, queues = [], returnAt = null, note = '' }) {
        s.busy = true;
        const now = this.clock.now();
        let results = [];
        if (mode === 'available') {
            // Clearing extra queues mid-shift uses manual (Offline, still on
            // shift): logout is reserved for the end of the agent's day
            if (s.needsReset) {
                results.push(await this.api.agentAction(id, 'all', 'manual'));
            }
            for (const q of queues) results.push(await this.api.agentAction(id, q, 'login'));
        } else if (mode === 'off') {
            results.push(await this.api.agentAction(id, 'all', 'logout'));
        } else if (mode === 'away') {
            results.push(await this.api.agentAction(id, 'all', reason));
        } else if (mode === 'onecall') {
            // onecall on a single queue keeps the agent out of their other queues
            results.push(await this.api.agentAction(id, 'all', 'manual'));
            for (const q of queues) results.push(await this.api.agentAction(id, q, 'onecall'));
        } else if (mode === 'manual') {
            results.push(await this.api.agentAction(id, 'all', 'manual'));
        }
        s.busy = false;
        const failed = results.filter(r => !r.ok);
        if (failed.length && failed.length === results.length) {
            s.retryAt = now + MIN;
            this.log(`${id}: ${mode}${reason ? '(' + reason + ')' : ''} failed: ${failed[0].error}`);
            return false;
        }
        if (failed.length) this.log(`${id}: ${failed.length}/${results.length} actions failed for ${mode}: ${failed[0].error}`);
        const prev = s.mode;
        s.mode = mode;
        s.reason = reason;
        s.queues = queues;
        s.since = now;
        s.returnAt = returnAt;
        s.lastActionAt = Date.now();
        s.needsReset = false;
        s.retryAt = null;
        this.dirty = true;
        this.log(`${id}: ${prev} -> ${mode}${reason ? ' (' + reason + ')' : ''}` +
            `${queues.length && mode !== 'away' ? ' q=' + queues.join(',') : ''}` +
            `${returnAt ? ' until ' + formatLocal(returnAt, this.d.timezone) : ''}${note ? ' ' + note : ''}`);
        this._maybeVerify(id, mode);
        return true;
    }

    async _maybeVerify(id, mode) {
        if (this.api.dryRun || !this.rng.chance(this.d.engine.verifySamplePct)) return;
        await new Promise(r => setTimeout(r, 5000));
        try {
            const st = await this.api.agentStatus(id);
            const action = st['callqueue-agent-status-action'];
            const expected = { available: 'login', off: 'logout', manual: 'manual', onecall: 'onecall' }[mode];
            const ok = expected ? action === expected : !['login', 'logout', 'manual', 'onecall'].includes(action);
            this._countDrift(ok ? 'verify_ok' : 'verify_mismatch');
            if (!ok) this.log(`${id}: verify mismatch, expected ${mode}, server says ${action} (${st['callqueue-agent-status-label']})`);
        } catch (e) {
            this._countDrift('verify_error');
        }
    }

    _countDrift(kind) {
        this.counters.drift[kind] = (this.counters.drift[kind] || 0) + 1;
    }

    _countReactive(kind) {
        this.counters.reactive[kind] = (this.counters.reactive[kind] || 0) + 1;
    }

    /** Advance one agent. Fire-and-forget: transitions run on the paced queue. */
    _stepAgent(id, now) {
        const s = this.agentState(id);
        if (s.busy || (s.retryAt && now < s.retryAt)) return;
        const entry = this.roster.agents[id];
        // Disabled agents never work a shift, so they only ever need logging out
        if (entry.role === 'disabled') {
            if (s.mode !== 'off' || (s.driftRelogAt && now >= s.driftRelogAt)) {
                s.driftRelogAt = null;
                return this._transition(id, s, 'off', { note: '(disabled)' });
            }
            return;
        }
        const plan = this.plans[id];
        const st = this.d.statuses;
        const maxDefer = st.maxDeferMin * MIN;
        const queues = this._queuesFor(id, s, now);
        const onCall = this._onCall(id);

        // Drift correction scheduled by reconcile
        if (s.driftRelogAt && now >= s.driftRelogAt) {
            s.driftRelogAt = null;
            if (s.mode === 'available' && queues.length) {
                s.needsReset = true;
                return this._transition(id, s, 'available', { queues, note: '(drift fix)' });
            }
            if (s.mode === 'away') return this._transition(id, s, 'away', { reason: s.reason, returnAt: s.returnAt, note: '(drift fix)' });
            if (s.mode === 'off') return this._transition(id, s, 'off', { note: '(drift fix)' });
        }

        // Off shift
        if (!queues.length) {
            if (s.mode === 'off') return;
            const shiftEnd = plan && plan.working ? plan.end : (s.reserveUntil || now);
            if (onCall && st.deferWhileOnCall && now < shiftEnd + maxDefer && s.mode !== 'unknown') return;
            return this._transition(id, s, 'off', { note: plan && plan.working && now >= plan.end ? '(shift end)' : '' });
        }

        // On shift
        if (s.mode === 'off' || s.mode === 'unknown') {
            // First sight of an agent: clear whatever queues it is logged into
            if (s.mode === 'unknown') s.needsReset = true;
            const reserve = !(plan && plan.working && now >= plan.start && now < plan.end);
            return this._transition(id, s, 'available', { queues, note: reserve ? '(reserve call-in)' : '(shift start)' });
        }
        if (['away', 'onecall', 'manual'].includes(s.mode)) {
            if (s.returnAt && now >= s.returnAt) return this._transition(id, s, 'available', { queues, note: '(back)' });
            return;
        }
        if (s.mode === 'available') {
            // Queue set changed (e.g. reserve shift became a normal shift)
            if ((s.queues || []).join(',') !== queues.join(',')) {
                s.needsReset = true;
                return this._transition(id, s, 'available', { queues, note: '(queue change)' });
            }
            if (!plan || !plan.working) return;
            // Next excursion after the last one taken, skipping any missed
            // entirely (daemon was down) and a second lunch
            const minAway = (st.minAwayMin ?? 5) * MIN;
            const e = plan.excursions.find(x => x.at > (s.lastExcAt || 0) && x.at + x.durationMs > now &&
                !(x.reason === 'Lunch' && s.lunchTaken));
            if (!e || now < e.at) return;
            if (onCall && st.deferWhileOnCall && now - e.at < maxDefer) return;
            s.lastExcAt = e.at;
            const remaining = Math.min(e.durationMs, plan.end - now);
            if (remaining < minAway) return;
            if (e.reason === 'Lunch') s.lunchTaken = true;
            const returnAt = now + remaining;
            const note = now - e.at > MIN ? `(deferred ${Math.round((now - e.at) / MIN)}m)` : '';
            if (e.kind === 'away') return this._transition(id, s, 'away', { reason: e.reason, returnAt, note });
            if (e.kind === 'onecall') return this._transition(id, s, 'onecall', { queues: [queues[0]], returnAt, note });
            if (e.kind === 'manual') return this._transition(id, s, 'manual', { returnAt, note });
        }
    }

    tick() {
        const now = this.clock.now();
        this._ensurePlans(now);
        for (const id of Object.keys(this.roster.agents)) this._stepAgent(id, now);
        for (const ext of this.extensions) if (ext.onTick) ext.onTick(this, now);
        this._maybeBoost().catch(e => this.log(`call boost error: ${e.message}`));
        this._save();
    }

    // ------------------------------------------------------------ reconcile

    async reconcile() {
        const now = this.clock.now();
        let rows, queues;
        try {
            [rows, queues] = await Promise.all([this.api.listAgents(), this.api.listQueues()]);
        } catch (e) {
            this.log(`reconcile failed: ${e.message}`);
            return;
        }
        const agents = {};
        for (const r of rows) {
            const id = r['callqueue-agent-id'];
            if (!agents[id]) agents[id] = { onCall: false, rows: {}, registered: false };
            const a = agents[id];
            if (Number(r['active-calls-total-current'] || 0) > 0) a.onCall = true;
            if (r['callqueue-agent-has-registered-devices'] && r['callqueue-agent-has-registered-devices'] !== 'no') a.registered = true;
            a.rows[String(r.callqueue)] = {
                type: r['callqueue-agent-availability-type'],
                dispatch: r['callqueue-agent-availability-for-dispatch']
            };
        }
        const qmap = {};
        for (const q of queues) {
            qmap[String(q.callqueue)] = {
                waiting: Number(q['active-queued-calls-total-current'] || 0),
                available: Number(q['callqueue-count-agents-available'] || 0),
                total: Number(q['callqueue-count-agents-total'] || 0),
                loggedIn: Number(q.agent_loggedin_count || 0),
                autoLogoutAfterMissed: q['callqueue-agent-auto-logout-after-missed']
            };
        }
        this.observed = { agents, queues: qmap, at: now };

        this._detectDrift(now);
        await this._checkOffAgents(now);
        if (this.d.reactive.enabled) this._reactive(now);
        for (const ext of this.extensions) {
            if (ext.onReconcile) {
                try {
                    await ext.onReconcile(this, now);
                } catch (e) {
                    this.log(`extension ${ext.name || ''} failed: ${e.message}`);
                }
            }
        }
    }

    /**
     * Logout marks the end of an agent's day; any other status starts a shift.
     * An off agent left in Manual or an away reason looks the same as a
     * logged-out one in the queue rows (both "manual"), so every
     * drift.offCheckMin read each off agent's real status and log out any
     * whose last action is not logout.
     */
    async _checkOffAgents(now) {
        const every = (this.d.drift.offCheckMin ?? 15) * MIN;
        if (this.lastOffCheck && Date.now() - this.lastOffCheck < every) return;
        this.lastOffCheck = Date.now();
        const grace = this.d.drift.graceSec * 1000;
        const ids = Object.keys(this.roster.agents).filter(id => {
            const s = this.agentState(id);
            return s.mode === 'off' && !s.busy && !s.driftRelogAt && !(s.lastActionAt && Date.now() - s.lastActionAt < grace);
        });
        let fixed = 0;
        for (let i = 0; i < ids.length; i += 5) {
            await Promise.all(ids.slice(i, i + 5).map(async id => {
                try {
                    const st = await this.api.agentStatus(id);
                    const action = st['callqueue-agent-status-action'];
                    if (!action || action === 'logout') return;
                    const s = this.agentState(id);
                    if (s.mode !== 'off' || s.busy) return;
                    this._countDrift('not_logged_out');
                    s.driftRelogAt = now;
                    fixed++;
                    this.log(`${id}: off shift but last status is ${action} (${st['callqueue-agent-status-label']}); logging out`);
                } catch (e) {
                    // 404: no agent_log rows yet - nothing to end
                    if (e?.response?.status !== 404) this._countDrift('off_check_error');
                }
            }));
        }
        if (ids.length) this.log(`off-shift check: ${ids.length} agents checked, ${fixed} to log out`);
    }

    _detectDrift(now) {
        const grace = this.d.drift.graceSec * 1000;
        for (const [id, entry] of Object.entries(this.roster.agents)) {
            if (entry.role === 'disabled') continue;
            const s = this.agentState(id);
            const obs = this.observed.agents[id];
            if (!obs || s.busy || s.driftRelogAt || s.mode === 'onecall' || s.mode === 'unknown') continue;
            if (s.lastActionAt && Date.now() - s.lastActionAt < grace) continue;
            const types = Object.entries(obs.rows).filter(([, r]) => r.type !== 'disabled');
            let kind = null;
            if (s.mode === 'available') {
                const active = new Set(s.queues || []);
                if (types.some(([q, r]) => active.has(q) && r.type === 'manual')) {
                    kind = obs.registered ? 'logged_out_externally' : 'logged_out_unregistered';
                } else if (types.some(([q, r]) => !active.has(q) && r.type === 'automatic')) {
                    kind = 'extra_queue_login';
                }
            } else if (['off', 'away', 'manual'].includes(s.mode)) {
                if (types.some(([, r]) => r.type === 'automatic')) kind = 'logged_in_externally';
            }
            if (!kind) continue;
            this._countDrift(kind);
            const delay = kind === 'extra_queue_login' ? 0 : this.rng.range(this.d.drift.relogDelaySec) * 1000;
            s.driftRelogAt = now + delay;
            this.log(`${id}: drift ${kind} while ${s.mode}; re-applying in ${Math.round(delay / 1000)}s`);
        }
    }

    _reactive(now) {
        const r = this.d.reactive;
        for (const [q, info] of Object.entries(this.observed.queues)) {
            if (info.waiting < r.waitingThreshold) continue;
            if (this.lastReactive[q] && now - this.lastReactive[q] < r.cooldownMin * MIN) continue;
            this.lastReactive[q] = now;
            let acted = false;

            if (r.shortenBreaks) {
                for (const [id, s] of Object.entries(this.state.agents)) {
                    if (s.mode !== 'away' || !(SHORTENABLE.has(s.reason) || /^cust/i.test(s.reason || ''))) continue;
                    if (!(this.plans[id]?.activeQueues || []).includes(q)) continue;
                    // Never shorter than the minimum away time
                    if (now - s.since < (this.d.statuses.minAwayMin ?? 5) * MIN || !s.returnAt || s.returnAt - now < 2 * MIN) continue;
                    s.returnAt = now;
                    acted = true;
                    this._countReactive('break_shortened');
                    this.log(`${id}: break cut short, queue ${q} has ${info.waiting} waiting`);
                    break;
                }
            }
            if (r.pullReserve) {
                const reserved = Object.values(this.state.agents).filter(s => s.reserveUntil && now < s.reserveUntil && (s.reserveQueues || []).includes(q)).length;
                const room = r.maxReservePerQueue - reserved;
                const candidates = Object.entries(this.roster.agents)
                    .filter(([id, e]) => e.role === 'idle' && e.queues.includes(q))
                    .filter(([id]) => {
                        const s = this.agentState(id);
                        return s.mode === 'off' && !(s.reserveUntil && now < s.reserveUntil);
                    })
                    .map(([id]) => id);
                for (const id of this.rng.shuffle(candidates).slice(0, Math.max(0, room))) {
                    const s = this.agentState(id);
                    s.reserveUntil = now + this.rng.range(r.reserveMin) * MIN;
                    s.reserveQueues = [q];
                    acted = true;
                    this._countReactive('reserve_called_in');
                    this.log(`${id}: reserve called in to ${q} until ${formatLocal(s.reserveUntil, this.d.timezone)} (${info.waiting} waiting)`);
                }
            }
            if (acted) this.dirty = true;
        }
    }

    // ------------------------------------------------------------ call boost

    /**
     * Weighted RANDOM CSV of this domain's queue DIDs for the call boost:
     * phone numbers whose dial rule is to-callqueue, each repeated by its
     * queue's callBoost.queueWeights entry (default 1). Rebuilt hourly.
     */
    async _boostCsv() {
        const file = path.join(stateDir(this.d), 'boost_numbers.csv');
        try {
            if (Date.now() - fs.statSync(file).mtimeMs < 60 * MIN) return file;
        } catch (e) { /* build it */ }
        const res = await this.api.client.apiGet(`domains/${encodeURIComponent(this.d.domain)}/phonenumbers`, { limit: 1000 });
        const rows = (Array.isArray(res.data) ? res.data : [])
            .filter(n => n['dial-rule-application'] === 'to-callqueue' && n.phonenumber);
        if (!rows.length) throw new Error('no to-callqueue phone numbers in the domain');
        const weights = this.d.callBoost.queueWeights || {};
        const lines = ['RANDOM'];
        for (const n of rows) {
            const q = String(n['dial-rule-translation-destination-user'] || '');
            const w = Math.max(0, Math.round(weights[q] ?? 1));
            for (let i = 0; i < w; i++) lines.push(`${n.phonenumber};${this.d.domain};queue ${q}`);
        }
        if (lines.length === 1) throw new Error('every queue has weight 0');
        fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
        this.log(`call boost: wrote ${lines.length - 1} weighted rows (${rows.length} queue DIDs) to ${file}`);
        return file;
    }

    async _maybeBoost() {
        const cb = this.d.callBoost;
        if (!cb.enabled || this.api.dryRun || this.clock.scale !== 1) return;
        const slot = Math.floor(Date.now() / (5 * MIN));
        if (slot === this.lastBoostSlot) return;
        this.lastBoostSlot = slot;
        const script = path.join(REPO_ROOT, 'sipp', 'scripts', 'domain_inbound.sh');
        if (!fs.existsSync(script)) {
            this.log(`call boost: ${script} not found`);
            return;
        }
        let csv;
        try {
            csv = await this._boostCsv();
        } catch (e) {
            this.log(`call boost skipped: ${e.message}`);
            return;
        }
        const args = ['--server', this.d.server, '--domain', this.d.domain, '--csv', csv,
            '--cps', String(cb.extraPeakCps), '--talk', `${cb.talkSec[0]},${cb.talkSec[1]}`,
            '--transport', cb.transport || 'u1', '--tz-offset', String(this._tzOffsetHours())];
        const child = spawn(script, args, { detached: true, stdio: 'ignore' });
        child.on('error', e => this.log(`call boost launch failed: ${e.message}`));
        child.unref();
        this.log(`call boost launched: ${args.join(' ')}`);
    }

    /** Domain's current UTC offset in hours, for cps_multiplier's CPS_TZ_OFFSET */
    _tzOffsetHours() {
        const { zoneOffsetMs } = require('./time');
        return Math.round(zoneOffsetMs(Date.now(), this.d.timezone) / 3600000);
    }

    // ------------------------------------------------------------ metrics

    snapshotMetrics() {
        const perQueue = {};
        const bump = (q, state) => {
            perQueue[q] = perQueue[q] || {};
            perQueue[q][state] = (perQueue[q][state] || 0) + 1;
        };
        for (const [id, entry] of Object.entries(this.roster.agents)) {
            const s = this.state.agents[id] || { mode: 'unknown' };
            const onCall = this._onCall(id);
            const qs = entry.role === 'disabled' ? entry.queues : (s.mode === 'available' || s.mode === 'onecall') ? (s.queues || []) : entry.queues;
            for (const q of qs) {
                let state = entry.role === 'disabled' ? 'disabled' : s.mode;
                if (onCall && (s.mode === 'available' || s.mode === 'onecall')) state = 'oncall';
                if (state === 'away' && s.reason) state = `away_${s.reason}`;
                bump(q, state);
            }
        }
        return {
            server: this.d.server,
            domain: this.d.domain,
            perQueue,
            queues: this.observed.queues,
            actions: this.api.counters,
            drift: this.counters.drift,
            reactive: this.counters.reactive,
            extensions: this.extensions.filter(e => e.metrics).map(e => e.metrics())
        };
    }

    shutdown() {
        this._save(true);
    }
}

module.exports = { DomainEngine };
