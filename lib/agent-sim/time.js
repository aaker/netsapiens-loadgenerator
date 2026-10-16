// Time helpers for agent-sim: wall-clock math in an IANA time zone, plus a
// scalable clock so a workday can be compressed for smoke tests.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatterCache = new Map();
function formatter(timeZone) {
    if (!formatterCache.has(timeZone)) {
        formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            weekday: 'short'
        }));
    }
    return formatterCache.get(timeZone);
}

/** Wall-clock parts of an instant (epoch ms) in a time zone. */
function wallClock(epochMs, timeZone) {
    const parts = {};
    for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
    const w = {
        year: +parts.year, month: +parts.month, day: +parts.day,
        hour: +parts.hour, minute: +parts.minute, second: +parts.second,
        dow: parts.weekday
    };
    w.dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    w.minuteOfDay = w.hour * 60 + w.minute + w.second / 60;
    return w;
}

/** Offset of the zone from UTC at an instant, in ms (e.g. -7h for MST). */
function zoneOffsetMs(epochMs, timeZone) {
    const w = wallClock(epochMs, timeZone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of a wall-clock time ("YYYY-MM-DD" + minutes after midnight) in a zone. */
function epochOf(dateKey, minuteOfDay, timeZone) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0) + Math.round(minuteOfDay * 60000);
    // Two passes settle DST edges
    let t = guess - zoneOffsetMs(guess, timeZone);
    t = guess - zoneOffsetMs(t, timeZone);
    return t;
}

/** "HH:MM" -> minutes after midnight */
function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) throw new Error(`Invalid time "${s}" (expected HH:MM)`);
    return (+m[1]) * 60 + (+m[2]);
}

/** RFC 3339 with the zone's offset, the form the statistics endpoints expect. */
function formatForApi(epochMs, timeZone) {
    const w = wallClock(epochMs, timeZone);
    const off = zoneOffsetMs(epochMs, timeZone) / 60000;
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const pad = n => String(n).padStart(2, '0');
    return `${w.dateKey}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function formatLocal(epochMs, timeZone) {
    const w = wallClock(epochMs, timeZone);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * Simulation clock. With scale 1 it is the real clock. With scale N, simulated
 * time advances N times faster from the moment the clock was created, so a
 * full shift can be exercised in minutes (testing only: the server's own
 * agent_log timestamps stay real).
 */
class SimClock {
    constructor(scale = 1, startAt = null) {
        this.scale = scale > 0 ? scale : 1;
        this.realStart = Date.now();
        this.simStart = startAt != null ? startAt : this.realStart;
    }
    now() {
        return this.simStart + (Date.now() - this.realStart) * this.scale;
    }
    /** Real ms to wait for `simMs` of simulated time */
    toReal(simMs) {
        return simMs / this.scale;
    }
}

module.exports = { DOW, wallClock, zoneOffsetMs, epochOf, parseHHMM, formatForApi, formatLocal, SimClock };
