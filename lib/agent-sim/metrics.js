// Prometheus textfile output for agent-sim (agent_sim.prom next to the
// metrics-server's sipp.prom, which is never touched). Written atomically
// (tmp + rename), only when the textfile collector directory exists.

const fs = require('fs');
const path = require('path');

const DEFAULT_TEXTFILE = '/usr/local/NetSapiens/agent/textfile_collector/sipp.prom';

function outputPath() {
    const dir = path.dirname(process.env.TEXTFILE_PATH || DEFAULT_TEXTFILE);
    return path.join(dir, 'agent_sim.prom');
}

const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const labels = obj => '{' + Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';

function render(snapshots) {
    const out = [];
    const metric = (name, type, help) => {
        out.push(`# HELP ${name} ${help}`);
        out.push(`# TYPE ${name} ${type}`);
    };

    metric('agentsim_agents', 'gauge', 'Simulated agents per queue by intended state (oncall from live API)');
    for (const s of snapshots) {
        for (const [queue, states] of Object.entries(s.perQueue)) {
            for (const [state, n] of Object.entries(states)) {
                out.push(`agentsim_agents${labels({ server: s.server, domain: s.domain, queue, state })} ${n}`);
            }
        }
    }

    metric('agentsim_queue_waiting', 'gauge', 'Callers waiting per queue (active-queued-calls-total-current)');
    for (const s of snapshots) {
        for (const [queue, q] of Object.entries(s.queues)) {
            out.push(`agentsim_queue_waiting${labels({ server: s.server, domain: s.domain, queue })} ${q.waiting}`);
        }
    }

    metric('agentsim_queue_agents_available', 'gauge', 'Agents available per queue as reported by the API');
    for (const s of snapshots) {
        for (const [queue, q] of Object.entries(s.queues)) {
            out.push(`agentsim_queue_agents_available${labels({ server: s.server, domain: s.domain, queue })} ${q.available}`);
        }
    }

    metric('agentsim_actions_total', 'counter', 'API writes by action and result');
    for (const s of snapshots) {
        for (const [key, n] of Object.entries(s.actions)) {
            const [action, result] = key.split('|');
            out.push(`agentsim_actions_total${labels({ server: s.server, domain: s.domain, action, result })} ${n}`);
        }
    }

    metric('agentsim_drift_total', 'counter', 'Differences between intended and observed agent state');
    for (const s of snapshots) {
        for (const [kind, n] of Object.entries(s.drift)) {
            out.push(`agentsim_drift_total${labels({ server: s.server, domain: s.domain, kind })} ${n}`);
        }
    }

    metric('agentsim_reactive_total', 'counter', 'Reactive staffing events (reserve call-ins, shortened breaks)');
    for (const s of snapshots) {
        for (const [kind, n] of Object.entries(s.reactive)) {
            out.push(`agentsim_reactive_total${labels({ server: s.server, domain: s.domain, kind })} ${n}`);
        }
    }

    // Extension metrics: [{name, type, help, samples: [{labels, value}]}]
    const ext = {};
    for (const s of snapshots) {
        for (const list of s.extensions || []) {
            for (const m of list) {
                ext[m.name] = ext[m.name] || { ...m, samples: [] };
                for (const smp of m.samples) {
                    ext[m.name].samples.push({ labels: { server: s.server, domain: s.domain, ...smp.labels }, value: smp.value });
                }
            }
        }
    }
    for (const m of Object.values(ext)) {
        metric(m.name, m.type, m.help);
        for (const smp of m.samples) out.push(`${m.name}${labels(smp.labels)} ${smp.value}`);
    }

    metric('agentsim_last_update_timestamp_seconds', 'gauge', 'When agent-sim last wrote this file');
    out.push(`agentsim_last_update_timestamp_seconds ${Math.floor(Date.now() / 1000)}`);
    return out.join('\n') + '\n';
}

function writeMetrics(snapshots) {
    const file = outputPath();
    if (!fs.existsSync(path.dirname(file))) return false;
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, render(snapshots));
    fs.renameSync(tmp, file);
    return true;
}

module.exports = { writeMetrics, render, outputPath };
