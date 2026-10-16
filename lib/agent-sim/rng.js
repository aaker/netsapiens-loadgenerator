// Seeded random helpers (seedrandom), so a given seed + date + agent always
// produces the same day plan and the same roster.

const seedrandom = require('seedrandom');

function makeRng(seed) {
    const next = seedrandom(String(seed));
    const rng = {
        next,
        /** float in [a, b) */
        float(a, b) { return a + next() * (b - a); },
        /** integer in [a, b] inclusive */
        int(a, b) { return Math.floor(a + next() * (b - a + 1)); },
        /** value from a [min, max] pair (or a plain number) */
        range(r) {
            if (Array.isArray(r)) return rng.float(r[0], r[1]);
            return Number(r);
        },
        /** integer from a [min, max] pair (or a plain number) */
        intRange(r) {
            if (Array.isArray(r)) return rng.int(r[0], r[1]);
            return Math.round(Number(r));
        },
        chance(p) { return next() < p; },
        pick(arr) { return arr[Math.floor(next() * arr.length)]; },
        /** key from a {key: weight} map */
        weighted(weights) {
            const entries = Object.entries(weights).filter(([, w]) => w > 0);
            const total = entries.reduce((s, [, w]) => s + w, 0);
            if (!total) return null;
            let r = next() * total;
            for (const [k, w] of entries) {
                r -= w;
                if (r < 0) return k;
            }
            return entries[entries.length - 1][0];
        },
        shuffle(arr) {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        },
        /** Weighted sample of `n` distinct items; weightFn(item) >= 0 */
        sampleWeighted(items, n, weightFn) {
            // Efraimidis-Spirakis: key = u^(1/w), take the n largest
            return items
                .map(item => {
                    const w = Math.max(weightFn(item), 1e-9);
                    return { item, key: Math.pow(next(), 1 / w) };
                })
                .sort((a, b) => b.key - a.key)
                .slice(0, n)
                .map(x => x.item);
        },
        /** Exponential inter-arrival in minutes for a rate per hour */
        expMinutes(ratePerHour) {
            if (ratePerHour <= 0) return Infinity;
            return -Math.log(1 - next()) * 60 / ratePerHour;
        }
    };
    return rng;
}

module.exports = { makeRng };
