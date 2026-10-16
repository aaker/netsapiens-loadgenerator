// Domain-scoped NetSapiens API wrapper for agent-sim.
//
// Every write goes through a paced queue:
//   - at most `concurrency` requests in flight;
//   - at least `perAgentSpacingMs` between two actions on the same agent,
//     because the API skips a second agent_log write for an agent within the
//     same second (CallqueuesController::create_agentlog).
// In dry-run mode reads still go to the server; writes are only logged.

const { ServerApiClient, describeApiError } = require('../nsapi');

const enc = encodeURIComponent;

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DomainApi {
    constructor(d, { dryRun = false, log = console.log, counters = null } = {}) {
        this.domain = d.domain;
        this.client = new ServerApiClient(d.serverConfig);
        this.dryRun = dryRun;
        this.log = log;
        this.concurrency = d.engine.concurrency;
        this.spacingMs = d.engine.perAgentSpacingMs;
        this.counters = counters || {};
        this.inFlight = 0;
        this.waiters = [];
        this.lastAgentAction = new Map(); // agentId -> epoch ms
        this.agentChains = new Map();     // agentId -> promise (serialises per agent)
    }

    _count(action, result) {
        const key = `${action}|${result}`;
        this.counters[key] = (this.counters[key] || 0) + 1;
    }

    async _slot() {
        if (this.inFlight < this.concurrency) {
            this.inFlight++;
            return;
        }
        await new Promise(r => this.waiters.push(r));
        this.inFlight++;
    }

    _release() {
        this.inFlight--;
        const next = this.waiters.shift();
        if (next) next();
    }

    /**
     * Run a write. `agentId` (optional) serialises and spaces writes per agent.
     * Returns {ok, status, data, error}. Never throws.
     */
    write(label, agentId, fn) {
        const run = async () => {
            if (agentId) {
                const last = this.lastAgentAction.get(agentId) || 0;
                const wait = last + this.spacingMs - Date.now();
                if (wait > 0) await sleep(wait);
            }
            await this._slot();
            try {
                if (this.dryRun) {
                    this.log(`[dry-run] ${label}`);
                    this._count(label.split(' ')[0], 'dry-run');
                    return { ok: true, status: 0, dryRun: true };
                }
                const res = await fn();
                this._count(label.split(' ')[0], 'ok');
                return { ok: true, status: res.status, data: res.data };
            } catch (error) {
                this._count(label.split(' ')[0], 'error');
                return { ok: false, status: error?.response?.status || 0, error: describeApiError(error) };
            } finally {
                if (agentId) this.lastAgentAction.set(agentId, Date.now());
                this._release();
            }
        };
        if (!agentId) return run();
        const prev = this.agentChains.get(agentId) || Promise.resolve();
        const p = prev.then(run, run);
        this.agentChains.set(agentId, p.catch(() => {}));
        return p;
    }

    // ------------------------------------------------------------- reads

    async listQueues() {
        const res = await this.client.apiGet(`domains/${enc(this.domain)}/callqueues`, { limit: 1000 });
        return Array.isArray(res.data) ? res.data : [];
    }

    /**
     * Light, one-request view used by the reconcile loop. The domain endpoint
     * returns ONE row per agent, with its queues in `queue_list` and the
     * per-queue availability type in the parallel `queue_list_status`; this
     * expands that into one row per agent per queue. Per-membership fields
     * other than the availability type (wrap-up, dispatch state, ...) are the
     * agent-level values and must not be relied on - use listMemberships().
     */
    async listAgents() {
        const res = await this.client.apiGet(`domains/${enc(this.domain)}/agents`, { limit: 10000 });
        const rows = Array.isArray(res.data) ? res.data : [];
        const out = [];
        for (const r of rows) {
            const queues = String(r.queue_list || r.callqueue || '').split(',').map(x => x.trim()).filter(Boolean);
            const types = String(r.queue_list_status || '').split(',').map(x => x.trim());
            queues.forEach((q, i) => {
                out.push({
                    ...r,
                    callqueue: q,
                    'callqueue-agent-availability-type': types[i] || r['callqueue-agent-availability-type'],
                    _expanded: true
                });
            });
        }
        return out;
    }

    /** Exact rows, one per agent per queue, from each queue's agent list */
    async listMemberships(queues) {
        const qs = queues || (await this.listQueues()).map(q => String(q.callqueue));
        const out = [];
        for (const q of qs) {
            const res = await this.client.apiGet(`domains/${enc(this.domain)}/callqueues/${enc(q)}/agents`, { limit: 5000 });
            for (const r of Array.isArray(res.data) ? res.data : []) out.push({ ...r, callqueue: String(r.callqueue || q) });
        }
        return out;
    }

    async agentStatus(agentId) {
        const res = await this.client.apiGet(`domains/${enc(this.domain)}/agents/${enc(agentId)}/status`);
        return res.data;
    }

    async stats(kind, params) {
        const paths = {
            agentLog: 'statistics/agentLog',
            agent: 'statistics/agent',
            perQueue: 'statistics/callqueues/per-queue'
        };
        const res = await this.client.apiGet(`domains/${enc(this.domain)}/${paths[kind]}`, params);
        return res.data;
    }

    // ------------------------------------------------------------- agent state

    /**
     * Status action. `queue` is a queue extension or "all". Away reasons
     * (Break, Lunch, cust3, ...) must use "all"; the API returns 400 otherwise.
     */
    agentAction(agentId, queue, action) {
        const p = `domains/${enc(this.domain)}/callqueues/${enc(queue)}/agents/${enc(agentId)}/${enc(action)}`;
        return this.write(`${action} ${agentId} q=${queue}`, agentId, () => this.client.apiPatch(p));
    }

    // ------------------------------------------------------------- roster

    addAgent(queue, body) {
        const p = `domains/${enc(this.domain)}/callqueues/${enc(queue)}/agents`;
        return this.write(`add-agent ${body['callqueue-agent-id']} q=${queue}`, body['callqueue-agent-id'],
            () => this.client.apiPostJson(p, { synchronous: 'yes', ...body }));
    }

    updateAgent(queue, agentId, body) {
        const p = `domains/${enc(this.domain)}/callqueues/${enc(queue)}/agents/${enc(agentId)}`;
        return this.write(`update-agent ${agentId} q=${queue} ${JSON.stringify(body)}`, agentId,
            () => this.client.apiPutJson(p, body));
    }

    deleteAgent(queue, agentId) {
        const p = `domains/${enc(this.domain)}/callqueues/${enc(queue)}/agents/${enc(agentId)}`;
        return this.write(`delete-agent ${agentId} q=${queue}`, agentId, () => this.client.apiDelete(p));
    }

    // ------------------------------------------------------------- labels

    /** Domain-scoped UI configuration (e.g. PORTAL_CALL_QUEUE_STATUS_CUSTOM_1) */
    setDomainConfiguration(name, value) {
        return this.write(`set-config ${name}=${value}`, null, async () => {
            try {
                return await this.client.apiPostJson('configurations', {
                    'config-name': name, 'config-value': String(value), domain: this.domain
                });
            } catch (e) {
                if (e?.response?.status !== 409) throw e;
                return this.client.apiPutJson(`configurations/${enc(name)}`, {
                    'config-value': String(value), domain: this.domain
                });
            }
        });
    }

    setDomainSetting(name, value) {
        const p = `domains/${enc(this.domain)}/settings/${enc(name)}`;
        return this.write(`set-setting ${name}`, null, () => this.client.apiPutJson(p, { value }));
    }
}

module.exports = { DomainApi, sleep };
