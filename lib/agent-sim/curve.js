// The business-day call curve from sipp/scripts/cps-utils.sh (cps_multiplier),
// ported so agent shifts can follow the same calling pattern the SIPp scripts
// generate. Reads the same CPS_* .env markers with the same defaults.
//
// Also builds "curve" shift waves: staggered start times from an opening batch
// ahead of the morning ramp to a closing batch that leaves on the hour after
// the evening cliff, sized so planned coverage tracks the curve.

const { parseHHMM } = require('./time');

function markers() {
    const num = (k, dflt) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : dflt);
    return {
        tzOffset: num('CPS_TZ_OFFSET', -7),
        rampStart: num('CPS_RAMP_START_HOUR', 6),
        peakHour: num('CPS_PEAK_HOUR', 9),
        lunchStart: num('CPS_LUNCH_START_HOUR', 11),
        lunchEnd: num('CPS_LUNCH_END_HOUR', 13),
        cliffStart: num('CPS_CLIFF_START_HOUR', 17),
        cliffEnd: num('CPS_CLIFF_END_HOUR', 19),
        overnight: num('CPS_OVERNIGHT', 0.05),
        deepOvernight: num('CPS_DEEP_OVERNIGHT', 0.005),
        peak: num('CPS_PEAK', 1.0),
        plateau: num('CPS_PLATEAU', 0.93),
        trough: num('CPS_LUNCH_TROUGH', 0.78),
        cliffLevel: num('CPS_CLIFF_LEVEL', 0.40)
    };
}

/** Weekday multiplier at a fractional hour in the curve's own local time. */
function multiplierAt(h, m = markers()) {
    h = ((h % 24) + 24) % 24;
    const overnightDuration = (24 - m.cliffEnd) + m.rampStart;
    const oA = (m.overnight + m.deepOvernight) / 2;
    const oB = (m.overnight - m.deepOvernight) / 2;
    if (h < m.rampStart) return oA + oB * Math.cos(2 * Math.PI * ((24 - m.cliffEnd) + h) / overnightDuration);
    if (h < m.peakHour) return m.overnight + (m.peak - m.overnight) * (h - m.rampStart) / (m.peakHour - m.rampStart);
    if (h < m.lunchStart) return m.peak - (m.peak - m.plateau) * (h - m.peakHour) / (m.lunchStart - m.peakHour);
    if (h < m.lunchEnd) {
        const A = (m.plateau + m.trough) / 2, B = (m.plateau - m.trough) / 2;
        return A + B * Math.cos(2 * Math.PI * (h - m.lunchStart) / (m.lunchEnd - m.lunchStart));
    }
    if (h < m.cliffStart) return m.plateau - (m.plateau - m.cliffLevel) * (h - m.lunchEnd) / (m.cliffStart - m.lunchEnd);
    if (h < m.cliffEnd) return m.cliffLevel - (m.cliffLevel - m.overnight) * (h - m.cliffStart) / (m.cliffEnd - m.cliffStart);
    return oA + oB * Math.cos(2 * Math.PI * (h - m.cliffEnd) / overnightDuration);
}

const hhmm = min => {
    const t = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Shift waves for a domain, in the domain's local time.
 *
 * The inbound scripts run the curve at CPS_TZ_OFFSET for every domain, so the
 * curve is shifted by (domain offset - CPS_TZ_OFFSET) to land in domain time.
 *
 * @param cfg  workday.curve settings
 * @param domainOffsetHours  the domain's current UTC offset
 * @returns {shifts: [{name, start, end, pct, startJitterMin, endJitterMin}], firstStart, lastEnd, rampAt, doneAt}
 */
function curveShifts(cfg, domainOffsetHours) {
    const m = markers();
    const shift = (domainOffsetHours - m.tzOffset) * 60; // minutes to add: curve time -> domain time
    const mult = domainMin => multiplierAt((domainMin - shift) / 60, m);
    const shiftMin = cfg.shiftHours * 60;
    const step = 5;

    // When calls "really" ramp up and when the main calling is done
    let rampAt = null, doneAt = null;
    for (let t = 0; t < 1440; t += step) {
        if (rampAt === null && mult(t) >= cfg.rampThreshold) rampAt = t;
        if (mult(t) >= cfg.doneThreshold) doneAt = t;
    }
    if (rampAt === null) throw new Error('workday.curve: the call curve never reaches rampThreshold');

    const every = cfg.waveEveryMin;
    const firstStart = Math.floor((rampAt - cfg.openLeadHours * 60) / every) * every;
    // The last group leaves on the hour
    const lastEnd = Math.ceil((doneAt + cfg.closeLagHours * 60) / 60) * 60;
    const lastStart = Math.max(firstStart, Math.floor((lastEnd - shiftMin) / every) * every);

    const starts = [];
    for (let s = firstStart; s <= lastStart; s += every) starts.push(s);
    // Wave i covers [start, start + shift); the closing wave is anchored on lastEnd
    const spanOf = i => (i === starts.length - 1 ? [lastEnd - shiftMin, lastEnd] : [starts[i], starts[i] + shiftMin]);

    // Least-squares fit of coverage to the curve (floored so the open and
    // close hours are staffed): keep adding the agent-unit that most reduces
    // the squared gap, until no wave improves it. The opening and closing
    // batches are seeded first so both always exist.
    const slots = [];
    for (let t = firstStart; t < lastEnd; t += 15) slots.push(t);
    const PEAK_UNITS = 100;
    const target = slots.map(t => PEAK_UNITS * Math.max(mult(t + 7.5), cfg.minCoverage));
    const covers = starts.map((_, i) => {
        const [a, b] = spanOf(i);
        return slots.map(t => (t >= a && t < b ? 1 : 0));
    });
    const cover = slots.map(() => 0);
    const counts = starts.map(() => 0);
    const add = (i, n = 1) => {
        counts[i] += n;
        covers[i].forEach((c, k) => { cover[k] += c * n; });
    };
    const seed = Math.max(1, Math.round(PEAK_UNITS * cfg.minWavePct));
    add(0, seed);
    if (starts.length > 1) add(starts.length - 1, seed);
    for (let guard = 0; guard < 5000; guard++) {
        let best = -1, bestDelta = 0;
        covers.forEach((cv, i) => {
            let delta = 0;
            cv.forEach((c, k) => { if (c) delta += 2 * (cover[k] - target[k]) + 1; });
            if (delta < bestDelta) { bestDelta = delta; best = i; }
        });
        if (best < 0) break;
        add(best);
    }
    const units = counts.reduce((a, b) => a + b, 0);

    const shifts = [];
    starts.forEach((s, i) => {
        if (!counts[i]) return;
        const last = i === starts.length - 1 && starts.length > 1;
        const [a, b] = spanOf(i);
        shifts.push({
            name: i === 0 ? 'open' : last ? 'close' : `w${hhmm(a).replace(':', '')}`,
            start: hhmm(a),
            end: hhmm(b),
            pct: counts[i] / units,
            // Openers arrive no earlier than the opening batch; closers leave on the hour
            startJitterMin: i === 0 ? [0, cfg.startSpreadMin] : [-cfg.startSpreadMin, cfg.startSpreadMin],
            ...(last ? { endJitterMin: [-10, 0] } : {})
        });
    });
    const coverage = slots.filter((_, k) => k % 4 === 0).map((t, j) => ({ at: hhmm(t), curve: Math.round(target[j * 4]), planned: cover[j * 4] }));
    return { shifts, coverage, units, firstStart: hhmm(firstStart), lastEnd: hhmm(lastEnd), rampAt: hhmm(rampAt), doneAt: hhmm(doneAt) };
}

module.exports = { markers, multiplierAt, curveShifts, parseHHMM };
