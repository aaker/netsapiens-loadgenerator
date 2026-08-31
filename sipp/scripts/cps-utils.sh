#!/bin/bash
# Shared time-of-day CPS multiplier for SIPp launch scripts.
# Source this file; do not execute it directly.
#
#   source "$BASE_DIR/sipp/scripts/cps-utils.sh"
#   CPS_MULTIPLIER=$(cps_multiplier)        # multiplier for right now
#   CPS_MULTIPLIER=$(cps_multiplier 68)     # multiplier for now + 68 minutes
#
# Curve expressed in local time via CPS_TZ_OFFSET (default -7 for PDT)
# Day-of-week scaling: Mon-Fri=100%, Sat=40%, Sun=20%
#
# All markers are configurable via .env. Defaults match observed traffic shape:
#
# Local Time | Multiplier             | Variable
# -----------|------------------------|-----------------------------
# 6am        | 0.05 (overnight edge)  | CPS_RAMP_START_HOUR / CPS_OVERNIGHT
# 9am        | 1.00 (peak)            | CPS_PEAK_HOUR / CPS_PEAK
# 10am       | 0.97 (derived)         | -
# 11am       | 0.93 (plateau)         | CPS_LUNCH_START_HOUR / CPS_PLATEAU
# 12pm       | 0.78 (trough)          | CPS_LUNCH_TROUGH
# 1pm        | 0.93 (plateau)         | CPS_LUNCH_END_HOUR / CPS_PLATEAU
# 3pm        | 0.67 (derived)         | -
# 5pm        | 0.40 (cliff)           | CPS_CLIFF_START_HOUR / CPS_CLIFF_LEVEL
# 6pm        | 0.23 (derived)         | -
# 7pm        | 0.05 (overnight edge)  | CPS_CLIFF_END_HOUR / CPS_OVERNIGHT
# 12:30am    | 0.005 (overnight deep) | CPS_DEEP_OVERNIGHT
# 6am        | 0.05 (overnight edge)  | CPS_RAMP_START_HOUR / CPS_OVERNIGHT
#
# Overnight (cliff_end -> ramp_start) is a cosine dip:
#   starts at CPS_OVERNIGHT, reaches CPS_DEEP_OVERNIGHT at the midpoint,
#   returns to CPS_OVERNIGHT before the morning ramp begins.

# Prints the business-day multiplier for local time now + $1 minutes (default 0).
cps_multiplier() {
    local offset_min=${1:-0}

    # Hour markers (local time)
    local tz_offset=${CPS_TZ_OFFSET:--7}
    local ramp_start=${CPS_RAMP_START_HOUR:-6}    # overnight ends, ramp begins
    local peak_hour=${CPS_PEAK_HOUR:-9}           # morning peak
    local lunch_start=${CPS_LUNCH_START_HOUR:-11} # plateau ends, lunch dip begins
    local lunch_end=${CPS_LUNCH_END_HOUR:-13}     # lunch dip ends, afternoon decline begins
    local cliff_start=${CPS_CLIFF_START_HOUR:-17} # afternoon ends, evening cliff begins
    local cliff_end=${CPS_CLIFF_END_HOUR:-19}     # cliff ends, overnight resumes

    # Level markers (multiplier 0.0-1.0)
    local overnight=${CPS_OVERNIGHT:-0.05}             # overnight edge (at 7pm and 6am)
    local deep_overnight=${CPS_DEEP_OVERNIGHT:-0.005}  # overnight deep floor (midpoint of overnight)
    local peak=${CPS_PEAK:-1.00}                       # morning peak level
    local plateau=${CPS_PLATEAU:-0.93}                 # level at 11am and 1pm (lunch dip endpoints)
    local trough=${CPS_LUNCH_TROUGH:-0.78}             # lunch trough at noon
    local cliff_level=${CPS_CLIFF_LEVEL:-0.40}         # level at start of evening cliff

    local hour_utc min_utc dow_utc
    hour_utc=$(date -u +%H)
    min_utc=$(date -u +%M)
    dow_utc=$(date -u +%u)  # 1=Monday ... 6=Saturday, 7=Sunday (UTC)

    awk \
        -v hour="$hour_utc" -v min="$min_utc" -v offset_min="$offset_min" \
        -v offset="$tz_offset" -v dow_utc="$dow_utc" \
        -v ramp_start="$ramp_start" -v peak_hour="$peak_hour" \
        -v lunch_start="$lunch_start" -v lunch_end="$lunch_end" \
        -v cliff_start="$cliff_start" -v cliff_end="$cliff_end" \
        -v overnight="$overnight" -v deep_overnight="$deep_overnight" \
        -v peak="$peak" \
        -v plateau="$plateau" -v trough="$trough" \
        -v cliff_level="$cliff_level" \
        'BEGIN {
        pi = 3.14159265358979
        utc_frac = hour + (min + offset_min)/60
        # Convert to local fractional hour, wrap to [0,24)
        local_sum = utc_frac + offset
        local_frac = (local_sum + 48) % 24
        # Derive local day-of-week from the same offset (avoids Sunday-night
        # spikes when UTC has already rolled into Monday but local is still Sun).
        day_shift = 0
        if (local_sum < 0) day_shift = -1
        else if (local_sum >= 24) day_shift = 1
        dow = dow_utc + day_shift
        if (dow < 1) dow += 7
        if (dow > 7) dow -= 7
        # Overnight cosine dip spans cliff_end -> ramp_start (wrapping midnight)
        overnight_duration = (24 - cliff_end) + ramp_start
        overnight_A = (overnight + deep_overnight) / 2
        overnight_B = (overnight - deep_overnight) / 2
        if (local_frac < ramp_start) {
            # Early-morning overnight (post-midnight side of the dip)
            t = (24 - cliff_end) + local_frac
            mult = overnight_A + overnight_B * cos(2 * pi * t / overnight_duration)
        } else if (local_frac < peak_hour) {
            # Steep morning ramp
            mult = overnight + (peak - overnight) * (local_frac - ramp_start) / (peak_hour - ramp_start)
        } else if (local_frac < lunch_start) {
            # Morning plateau taper: peak -> plateau
            mult = peak - (peak - plateau) * (local_frac - peak_hour) / (lunch_start - peak_hour)
        } else if (local_frac < lunch_end) {
            # Lunch dip: cosine from plateau at lunch_start, trough at midpoint, plateau at lunch_end
            A = (plateau + trough) / 2
            B = (plateau - trough) / 2
            mult = A + B * cos(2 * pi * (local_frac - lunch_start) / (lunch_end - lunch_start))
        } else if (local_frac < cliff_start) {
            # Gradual afternoon decline: plateau -> cliff_level
            mult = plateau - (plateau - cliff_level) * (local_frac - lunch_end) / (cliff_start - lunch_end)
        } else if (local_frac < cliff_end) {
            # Steep evening cliff: cliff_level -> overnight
            mult = cliff_level - (cliff_level - overnight) * (local_frac - cliff_start) / (cliff_end - cliff_start)
        } else {
            # Late-evening overnight (pre-midnight side of the dip)
            t = local_frac - cliff_end
            mult = overnight_A + overnight_B * cos(2 * pi * t / overnight_duration)
        }
        # Day-of-week scaling (dow: 1=Mon...6=Sat, 7=Sun)
        if (dow == 6) mult = mult * 0.4
        else if (dow == 7) mult = mult * 0.2
        printf "%.4f", mult
    }'
}
