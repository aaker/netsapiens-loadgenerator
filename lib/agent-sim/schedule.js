// Day plans: for one agent on one local date, decide whether they work, their
// shift, which of their skill queues they staff today, and their excursions
// (lunch, breaks, random away, single-call, manual offline).
//
// Seeded by seed + date + agent, so a plan is stable across daemon restarts on
// the same day and different from one day to the next.

const { makeRng } = require('./rng');
const { epochOf, parseHHMM, wallClock } = require('./time');
const { profileFor } = require('./config');

const MIN = 60000;

/**
 * @param d       merged domain config
 * @param agentId user@domain
 * @param entry   roster entry {role, home, queues}
 * @param dateKey local date "YYYY-MM-DD"
 * @returns plan {dateKey, working, shift, start, end, activeQueues, awayMultiplier, excursions[]}
 */
function buildDayPlan(d, agentId, entry, dateKey) {
    const rng = makeRng(`${d.seed}:${dateKey}:${agentId}`);
    const tz = d.timezone;
    const w = d.workday;
    const noonEpoch = epochOf(dateKey, 12 * 60, tz);
    const dow = wallClock(noonEpoch, tz).dow;

    const plan = { dateKey, working: false, shift: null, start: null, end: null, activeQueues: [], awayMultiplier: 1, excursions: [] };
    if (!entry || entry.role !== 'active') return plan;

    // Who works today
    const workday = w.days.includes(dow);
    if (!workday && !rng.chance(w.weekendStaffingPct)) return plan;
    if (rng.chance(w.absenteeismPct)) {
        plan.absent = true;
        return plan;
    }

    // Shift, with jitter on both ends
    const shift = rng.weighted(Object.fromEntries(w.shifts.map((s, i) => [i, s.pct])));
    const s = w.shifts[Number(shift)];
    const startMin = parseHHMM(s.start) + rng.range(w.startJitterMin);
    const endMin = parseHHMM(s.end) + rng.range(w.endJitterMin);
    plan.working = true;
    plan.shift = s.name;
    plan.start = epochOf(dateKey, startMin, tz);
    plan.end = epochOf(dateKey, Math.max(endMin, startMin + 60), tz);

    // Which skill queues they log into today: each with the queue profile's
    // staffing probability; if none are chosen, the best-staffed one
    const queues = entry.queues || [];
    plan.activeQueues = queues.filter(q => rng.chance(profileFor(d, q).staffing ?? 1));
    if (!plan.activeQueues.length && queues.length) {
        plan.activeQueues = [queues.slice().sort((a, b) => (profileFor(d, b).staffing ?? 1) - (profileFor(d, a).staffing ?? 1))[0]];
    }
    const mults = plan.activeQueues.map(q => profileFor(d, q).awayMultiplier ?? 1);
    plan.awayMultiplier = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 1;

    const minAway = (d.statuses.minAwayMin ?? 5) * MIN;
    const gap = (w.minGapMin ?? 15) * MIN;
    const fixed = []; // lunch + scheduled breaks, placed first so random away never displaces them
    const conflicts = (at, dur, list) => list.some(e => at < e.at + e.durationMs + gap && e.at < at + dur + gap);

    // Exactly one lunch, inside the lunch window and the shift, for long-enough shifts
    let lunch = null;
    if ((plan.end - plan.start) / MIN >= (w.lunch.minShiftHours ?? 6) * 60) {
        const dur = rng.range(w.lunch.durationMin) * MIN;
        const lo = Math.max(epochOf(dateKey, parseHHMM(w.lunch.window[0]), tz), plan.start + 120 * MIN);
        // The window bounds the lunch START; it must still end 2h before shift end
        const hi = Math.min(epochOf(dateKey, parseHHMM(w.lunch.window[1]), tz), plan.end - 120 * MIN - dur);
        if (hi > lo) {
            lunch = { at: lo + rng.next() * (hi - lo), kind: 'away', reason: 'Lunch', durationMs: dur };
            fixed.push(lunch);
        }
    }

    // Scheduled breaks: spread evenly through the shift, nudged in 10-minute
    // steps off the lunch hour (and each other) when they collide
    const nBreaks = rng.intRange(w.breaks.count);
    for (let i = 0; i < nBreaks; i++) {
        const dur = Math.max(minAway, rng.range(w.breaks.durationMin) * MIN);
        const slot = (plan.end - plan.start) / (nBreaks + 1);
        const base = plan.start + slot * (i + 1) + (rng.next() - 0.5) * slot * 0.3;
        let placed = null;
        for (let step = 0; step < 36 && !placed; step++) {
            const offset = Math.ceil(step / 2) * 10 * MIN * (step % 2 ? 1 : -1);
            const at = base + offset;
            if (at < plan.start + 45 * MIN || at + dur > plan.end - 30 * MIN) continue;
            if (!conflicts(at, dur, fixed)) placed = { at, kind: 'away', reason: 'Break', durationMs: dur };
        }
        if (placed) fixed.push(placed);
    }

    // Random away events (Poisson) in the remaining gaps. Lunch and Break are
    // only ever the scheduled ones above.
    const st = d.statuses;
    const weights = { ...st.weights };
    delete weights.Lunch;
    delete weights.Break;
    const extra = [];
    const rate = st.randomAwayPerHour * plan.awayMultiplier;
    for (let t = plan.start + rng.expMinutes(rate) * MIN; t < plan.end - 15 * MIN; t += rng.expMinutes(rate) * MIN) {
        const reason = rng.weighted(weights);
        if (!reason) break;
        extra.push({ at: t, kind: 'away', reason, durationMs: Math.max(minAway, rng.range(st.randomAwayMin) * MIN) });
    }

    // Occasional single-call mode and manual offline
    if (rng.chance(st.onecallPct * plan.awayMultiplier)) {
        extra.push({ at: plan.start + rng.next() * (plan.end - plan.start), kind: 'onecall', reason: null, durationMs: Math.max(minAway, rng.range(st.onecallMin) * MIN) });
    }
    if (rng.chance(st.manualOfflinePct * plan.awayMultiplier)) {
        extra.push({ at: plan.start + rng.next() * (plan.end - plan.start), kind: 'manual', reason: null, durationMs: Math.max(minAway, rng.range(st.manualOfflineMin) * MIN) });
    }

    const all = fixed.slice();
    for (const e of extra.sort((a, b) => a.at - b.at)) {
        if (e.at + e.durationMs > plan.end - 5 * MIN) continue;
        if (!conflicts(e.at, e.durationMs, all)) all.push(e);
    }
    for (const e of all.sort((a, b) => a.at - b.at)) {
        e.at = Math.round(e.at);
        e.durationMs = Math.round(e.durationMs);
        plan.excursions.push(e);
    }
    plan.start = Math.round(plan.start);
    plan.end = Math.round(plan.end);
    return plan;
}

module.exports = { buildDayPlan };
