const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'jobs.jsonl');
const JOB_TTL_MS = 60 * 60 * 1000;

const STEP_DEFS = [
  { id: 'check-domain', label: 'Checking domain' },
  { id: 'claim-reseller', label: 'Reserving your account' },
  { id: 'purchase-number', label: 'Purchasing phone number' },
  { id: 'create-domain', label: 'Creating domain' },
  { id: 'create-user', label: 'Creating user' },
  { id: 'send-welcome', label: 'Sending welcome email' },
  { id: 'add-phonenumber', label: 'Adding number to inventory' }
];

const jobs = new Map();

function appendLog(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Failed to write jobs.jsonl:', err.message);
  }
}

function createJob(input, ip) {
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    ip,
    input,
    status: 'running',
    steps: STEP_DEFS.map(s => ({ id: s.id, label: s.label, status: 'pending' })),
    result: null,
    error: null,
    createdAt: Date.now()
  };
  jobs.set(job.id, job);
  appendLog({ ts: new Date().toISOString(), jobId: job.id, ip, step: 'created', status: 'running', detail: { email: input.email, domain: input.domain, company: input.companyName, areaCode: input.areaCode, ack911: input.ack911, ackNoSla: input.ackNoSla } });
  return job;
}

function setStep(job, stepId, status, detail) {
  const step = job.steps.find(s => s.id === stepId);
  if (step) step.status = status;
  appendLog({ ts: new Date().toISOString(), jobId: job.id, ip: job.ip, step: stepId, status, detail: detail || null });
}

// Log an operational event that is not a step transition (compensation,
// orphaned resources, warnings). Grep targets: orphaned_tn, recovery_needed,
// RESELLER_LEAKED, compensated, warn, dry_run.
function logEvent(job, tag, detail) {
  appendLog({ ts: new Date().toISOString(), jobId: job.id, ip: job.ip, step: tag, status: 'event', detail: detail || null });
}

function finishJob(job, result) {
  job.status = 'succeeded';
  job.result = result;
  appendLog({ ts: new Date().toISOString(), jobId: job.id, ip: job.ip, step: 'finished', status: 'succeeded', detail: result });
}

function failJob(job, code, message) {
  job.status = 'failed';
  job.error = { code, message };
  for (const step of job.steps) {
    if (step.status === 'running') step.status = 'failed';
  }
  appendLog({ ts: new Date().toISOString(), jobId: job.id, ip: job.ip, step: 'finished', status: 'failed', detail: { code, message } });
}

function getJob(id) {
  return jobs.get(id) || null;
}

// Public view: never expose ip/input internals to the polling client
function publicView(job) {
  return { status: job.status, steps: job.steps, result: job.result, error: job.error };
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== 'running') jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createJob, setStep, logEvent, finishJob, failJob, getJob, publicView };
