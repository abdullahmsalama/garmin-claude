"""Turns a decoded FIT file (+ optional Garmin chart extras) into what Claude needs from inside a workout:
a time series, per-km splits, laps, legs (multisport), strength sets, pauses, best efforts and an analysis
(HR drift / decoupling, efficiency factor, zones, pace variability). Pure functions, no network.
"""
import math

from fit import SPORT, EXERCISE

ANALYSIS_VERSION = 1
STOP_TYPES = {1, 4, 8, 9}
CH = ["speed", "hr", "cad", "pwr", "alt", "vo", "gct", "gct_bal", "vr", "stride", "temp", "resp", "perf"]


def r(v, d=1):
    if v is None or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    x = math.floor(v * 10 ** d + 0.5) / 10 ** d
    return int(x) if d == 0 else x


def pace_str(s):
    if s is None or not math.isfinite(s) or s <= 0 or s > 3600:
        return None
    t = int(math.floor(s + 0.5))
    return f"{t // 60}:{t % 60:02d}"


def pace_of(speed):  # s per km
    return 1000 / speed if speed and speed > 0.3 else None


def fmt_time(s):
    if s is None:
        return None
    s = int(math.floor(s + 0.5))
    h, m, x = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m}:{x:02d}"


def is_foot_sport(s):
    return s in ("running", "walking", "hiking", "generic", "training")


def mean(a):
    v = [x for x in a if isinstance(x, (int, float)) and math.isfinite(x)]
    return sum(v) / len(v) if v else None


def stdev(a):
    m = mean(a)
    if m is None or len(a) < 2:
        return None
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def first_num(a):
    return next((v for v in a if v is not None), None)


# Garmin chart metrics added on top of the file (names from /activity-service/activity/{id}/details).
EXTRA_KEYS = {"directGradeAdjustedSpeed": "gap", "directAvailableStamina": "stamina", "directPotentialStamina": "stamina_potential",
              "directBodyBattery": "body_battery", "directPerformanceCondition": "performance_condition", "directVerticalSpeed": "vertical_speed",
              "directRespirationRate": "respiration"}


def chart_extras(details):
    keys = [d.get("key") for d in (details or {}).get("metricDescriptors") or []]
    if "directTimestamp" not in keys:
        return None
    ti = keys.index("directTimestamp")
    rows = [m.get("metrics") for m in (details.get("activityDetailMetrics") or [])]
    rows = sorted([m for m in rows if isinstance(m, list) and len(m) > ti and m[ti] is not None], key=lambda m: m[ti])
    cols = [(name, keys.index(k)) for k, name in EXTRA_KEYS.items() if k in keys]
    if not rows or not cols:
        return None
    return {"ts": [m[ti] for m in rows], "cols": {name: [m[i] if i < len(m) else None for m in rows] for name, i in cols}}


def _nearest(ts, arr):
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if arr[mid] < ts:
            lo = mid + 1
        else:
            hi = mid
    return lo - 1 if lo > 0 and abs(arr[lo - 1] - ts) < abs(arr[lo] - ts) else lo


# ---------- points ----------
def _points(fit, sport):
    """One point per record: time, elapsed s, moving s, distance m and the channels (None when missing)."""
    recs = sorted([x for x in fit["records"] if x.get("timestamp") is not None], key=lambda x: x["timestamp"])
    if not recs:
        return [], []
    start = (fit["sessions"][0].get("start_time") if fit["sessions"] else None) or recs[0]["timestamp"]
    # Timer stop..start intervals from events; if there are none, gaps over 10 s count as pauses.
    timer = sorted([e for e in fit["events"] if e.get("event") == 0 and e.get("timestamp") is not None], key=lambda e: e["timestamp"])
    paused, stop_at = [], None
    for e in timer:
        if e.get("event_type") in STOP_TYPES:
            if stop_at is None:
                stop_at = e["timestamp"]
        elif e.get("event_type") == 0 and stop_at is not None:
            if e["timestamp"] - stop_at >= 1000:
                paused.append([stop_at, e["timestamp"]])
            stop_at = None
    had_events = bool(paused)

    def paused_in(t0, t1):
        return sum(max(0, min(b, t1) - max(a, t0)) for a, b in paused) / 1000

    foot = is_foot_sport(sport)
    pts, mt, dist, prev = [], 0.0, 0.0, None
    for x in recs:
        dt = (x["timestamp"] - prev["timestamp"]) / 1000 if prev else 0
        gap = dt > 10 and not had_events
        if prev and dt > 0 and not gap:
            mt += max(0, dt - paused_in(prev["timestamp"], x["timestamp"]))
        if gap:
            paused.append([prev["timestamp"], x["timestamp"]])
        speed = x.get("enhanced_speed") if x.get("enhanced_speed") is not None else x.get("speed")
        if x.get("distance") is not None:
            dist = x["distance"]
        elif speed is not None and prev and not gap:
            dist += speed * dt
        cad = x.get("cadence")
        if cad is not None:
            cad = (cad + (x.get("fractional_cadence") or 0)) * (2 if foot else 1)
        alt = x.get("enhanced_altitude") if x.get("enhanced_altitude") is not None else x.get("altitude")
        pts.append({
            "ts": x["timestamp"], "el": (x["timestamp"] - start) / 1000, "mt": mt, "d": dist, "speed": speed, "hr": x.get("heart_rate"), "cad": cad,
            "pwr": x.get("power"), "alt": alt, "vo": x["vertical_oscillation"] / 10 if x.get("vertical_oscillation") is not None else None,
            "gct": x.get("stance_time"), "gct_bal": x.get("stance_time_balance"), "vr": x.get("vertical_ratio"),
            "stride": x["step_length"] / 1000 if x.get("step_length") is not None else None, "temp": x.get("temperature"),
            "resp": x.get("enhanced_respiration_rate"), "perf": x.get("performance_condition"),
        })
        prev = x
    return pts, sorted(paused)


def _agg(pts, i0, i1):
    """Time-weighted averages over points [i0, i1] (by moving-time steps), plus max HR/power and climb."""
    s, w = {}, {}
    max_hr = max_pwr = None
    up = down = 0.0
    last_alt = None
    for i in range(max(i0, 1), i1 + 1):
        dt = pts[i]["mt"] - pts[i - 1]["mt"]
        for c in CH:
            v = pts[i].get(c)
            if v is not None and dt > 0:
                s[c] = s.get(c, 0) + v * dt
                w[c] = w.get(c, 0) + dt
        if pts[i]["hr"] is not None:
            max_hr = max(max_hr or 0, pts[i]["hr"])
        if pts[i]["pwr"] is not None:
            max_pwr = max(max_pwr or 0, pts[i]["pwr"])
        a = pts[i]["alt"]
        if a is not None:
            if last_alt is not None:
                dd = a - last_alt
                if abs(dd) >= 1:
                    if dd > 0:
                        up += dd
                    else:
                        down -= dd
                    last_alt = a
            else:
                last_alt = a
    return {"avg": lambda c: s[c] / w[c] if w.get(c) else None, "max_hr": max_hr, "max_pwr": max_pwr, "up": up, "down": down}


def _idx_at_distance(pts, target, frm=0):
    for i in range(frm, len(pts)):
        if pts[i]["d"] >= target:
            return i
    return -1


def _time_at_distance(pts, D):
    """Moving time at an exact distance (linear between the two records around it)."""
    i = _idx_at_distance(pts, D)
    if i <= 0:
        return pts[0]["mt"] if i == 0 else None
    a, b = pts[i - 1], pts[i]
    return b["mt"] if b["d"] == a["d"] else a["mt"] + (D - a["d"]) / (b["d"] - a["d"]) * (b["mt"] - a["mt"])


def _segment(pts, i0, i1, foot, exact=None):
    a = _agg(pts, i0, i1)
    dist = exact["dist"] if exact else pts[i1]["d"] - pts[i0]["d"]
    time = exact["time"] if exact else pts[i1]["mt"] - pts[i0]["mt"]
    sp = dist / time if time and time > 0 else None
    return {
        "distance_m": r(dist, 0), "time_s": r(time, 0), "pace_min_km": pace_str(pace_of(sp)) if foot else None, "speed_kmh": r(sp * 3.6) if not foot and sp else None,
        "avg_hr": r(a["avg"]("hr"), 0), "max_hr": a["max_hr"], "avg_cadence": r(a["avg"]("cad"), 0), "avg_power": r(a["avg"]("pwr"), 0), "max_power": a["max_pwr"],
        "elev_gain_m": r(a["up"], 0), "elev_loss_m": r(a["down"], 0),
        "vertical_oscillation_cm": r(a["avg"]("vo")), "ground_contact_ms": r(a["avg"]("gct"), 0), "gct_balance_left_pct": r(a["avg"]("gct_bal")),
        "vertical_ratio_pct": r(a["avg"]("vr")), "stride_m": r(a["avg"]("stride"), 2),
    }


RUN_DISTANCES = [(400, "400m"), (1000, "1k"), (1609.34, "1mile"), (3000, "3k"), (5000, "5k"), (10000, "10k"), (15000, "15k"), (21097.5, "half_marathon"), (42195, "marathon")]
RIDE_DISTANCES = [(5000, "5k"), (10000, "10k"), (20000, "20k"), (40000, "40k"), (100000, "100k")]


def _best_efforts(pts, foot):
    """Fastest time over each distance, using moving time (pauses don't count)."""
    out = {}
    for D, name in RUN_DISTANCES if foot else RIDE_DISTANCES:
        if not pts or pts[-1]["d"] - pts[0]["d"] < D:
            continue
        j, best = 0, None
        for i in range(1, len(pts)):
            while j + 1 < i and pts[i]["d"] - pts[j + 1]["d"] >= D:
                j += 1
            dd = pts[i]["d"] - pts[j]["d"]
            if dd >= D and dd > 0:
                t = (pts[i]["mt"] - pts[j]["mt"]) * D / dd
                if t > 0 and (best is None or t < best[0]):
                    best = (t, pts[j]["d"])
        if best:
            out[name] = {"time_s": r(best[0], 0), "time": fmt_time(best[0]), "pace_min_km": pace_str(best[0] / (D / 1000)) if foot else None,
                         "starts_at_km": r(best[1] / 1000, 2)}
    return out


def _best_power(pts):
    if not any(p["pwr"] is not None for p in pts):
        return None
    e = [0] + [(pts[i]["pwr"] or 0) * max(0, pts[i]["mt"] - pts[i - 1]["mt"]) for i in range(1, len(pts))]
    out = {}
    for S, name in [(5, "5s"), (15, "15s"), (30, "30s"), (60, "1min"), (300, "5min"), (600, "10min"), (1200, "20min"), (3600, "60min")]:
        j, total, best = 0, 0.0, None
        for i in range(1, len(pts)):
            total += e[i]
            while j + 1 < i and pts[i]["mt"] - pts[j + 1]["mt"] >= S:
                j += 1
                total -= e[j]
            span = pts[i]["mt"] - pts[j]["mt"]
            if span >= S and span > 0:
                v = total / span
                if best is None or v > best:
                    best = v
        if best is not None:
            out[name] = r(best, 0)
    return out or None


def _normalized_power(pts):
    p = [x["pwr"] for x in pts if x["pwr"] is not None]
    if len(p) < 60:
        return None
    roll, q, total = [], [], 0.0
    for v in p:
        q.append(v)
        total += v
        if len(q) > 30:
            total -= q.pop(0)
        if len(q) == 30:
            roll.append(total / 30)
    return r((sum(v ** 4 for v in roll) / len(roll)) ** 0.25, 0) if roll else None


# ---------- the whole thing ----------
def analyze(fit, extras=None, zones=None):
    """fit: decode_fit() output; extras: chart_extras() or None; zones: [z1..z5 floors] or None."""
    s0 = fit["sessions"][0] if fit["sessions"] else {}
    legs_raw = fit["sessions"] if len(fit["sessions"]) > 1 else None
    sport = SPORT.get(s0.get("sport")) or (f"sport_{s0['sport']}" if s0.get("sport") is not None else "unknown")
    pts, pauses = _points(fit, sport)
    foot = is_foot_sport(sport)
    res = {"v": ANALYSIS_VERSION, "sport": sport, "points": len(pts)}
    if extras:
        for p in pts:
            k = _nearest(p["ts"], extras["ts"])
            if abs(extras["ts"][k] - p["ts"]) <= 30000:
                for name, col in extras["cols"].items():
                    p[name] = col[k]

    # Series at a fixed moving-time resolution (max ~1500 points), averages per bucket.
    moving = pts[-1]["mt"] if pts else 0
    step = max(1, math.ceil(moving / 1500))
    chans = CH + (list(extras["cols"].keys()) if extras else [])
    series = {"step_s": step, "t_s": [], "elapsed_s": [], "km": []}
    for c in chans:
        series[c] = []
    b, i = 0, 0
    while i < len(pts):
        end = (b + 1) * step
        group = []
        while i < len(pts) and pts[i]["mt"] < end:
            group.append(pts[i])
            i += 1
        if not group:
            b = int(pts[i]["mt"] // step) or b + 1
            continue
        last = group[-1]
        series["t_s"].append(b * step)
        series["elapsed_s"].append(r(last["el"], 0))
        series["km"].append(r(last["d"] / 1000, 3))
        for c in chans:
            v = [g.get(c) for g in group if g.get(c) is not None]
            series[c].append(r(sum(v) / len(v), 2) if v else None)
        b += 1
    for c in chans:
        if all(v is None for v in series[c]):
            del series[c]
    res["series"] = series

    # Per-km splits (computed from distance, so a one-lap run still gets them).
    splits = []
    if len(pts) > 1 and pts[-1]["d"] >= 200:
        i0, k = 0, 1
        while True:
            i1 = _idx_at_distance(pts, k * 1000, i0)
            t_start = _time_at_distance(pts, (k - 1) * 1000) or 0
            if i1 < 0:
                rest = pts[-1]["d"] - (k - 1) * 1000
                if len(pts) - 1 > i0 and rest >= 50:
                    splits.append({"km": k, "partial": True, **_segment(pts, i0, len(pts) - 1, foot, {"dist": rest, "time": pts[-1]["mt"] - t_start})})
                break
            splits.append({"km": k, "partial": False, **_segment(pts, i0, i1, foot, {"dist": 1000, "time": _time_at_distance(pts, k * 1000) - t_start})})
            i0, k = i1, k + 1
        if extras and "gap" in extras["cols"]:
            for sp in splits:
                lo = (sp["km"] - 1) * 1000
                hi = lo + (sp["distance_m"] or 0)
                g = [p["gap"] for p in pts if lo < p["d"] <= hi and p.get("gap") is not None]
                sp["grade_adjusted_pace_min_km"] = pace_str(pace_of(sum(g) / len(g))) if g and foot else None
    res["splits_km"] = splits

    # Laps as recorded by the watch.
    def lap_speed(x):
        return x.get("enhanced_avg_speed") if x.get("enhanced_avg_speed") is not None else x.get("avg_speed")

    res["laps"] = [{
        "lap": n + 1, "distance_m": r(l.get("total_distance"), 0), "time_s": r(l.get("total_timer_time"), 0), "elapsed_s": r(l.get("total_elapsed_time"), 0),
        "pace_min_km": pace_str(pace_of(lap_speed(l))) if foot else None, "speed_kmh": r(lap_speed(l) * 3.6) if not foot and lap_speed(l) else None,
        "avg_hr": l.get("avg_heart_rate"), "max_hr": l.get("max_heart_rate"),
        "avg_cadence": r((l["avg_cadence"] + (l.get("avg_fractional_cadence") or 0)) * 2 if foot else l["avg_cadence"], 0) if l.get("avg_cadence") is not None else None,
        "avg_power": l.get("avg_power"), "elev_gain_m": l.get("total_ascent"), "elev_loss_m": l.get("total_descent"),
    } for n, l in enumerate(fit["laps"])]

    # Multisport legs (one session each).
    legs = None
    if legs_raw:
        legs = []
        for n, x in enumerate(legs_raw):
            sp = SPORT.get(x.get("sport")) or f"sport_{x.get('sport')}"
            f, v = is_foot_sport(sp), lap_speed(x)
            legs.append({"leg": n + 1, "sport": sp, "distance_km": r((x.get("total_distance") or 0) / 1000, 2), "time_s": r(x.get("total_timer_time"), 0),
                         "elapsed_s": r(x.get("total_elapsed_time"), 0), "pace_min_km": pace_str(pace_of(v)) if f else None, "speed_kmh": r(v * 3.6) if not f and v else None,
                         "avg_hr": x.get("avg_heart_rate"), "max_hr": x.get("max_heart_rate"), "avg_power": x.get("avg_power"), "elev_gain_m": x.get("total_ascent")})
    res["legs"] = legs

    # Strength sets (active sets and rests).
    def exercise(x):
        c = x.get("category")
        if not c:
            return None
        return "unidentified" if c[0] == 65534 else (EXERCISE[c[0]] if 0 <= c[0] < len(EXERCISE) else f"category_{c[0]}")

    res["sets"] = [{
        "set": n + 1, "type": "rest" if x.get("set_type") == 0 else "active", "exercise": exercise(x),
        "exercise_subtype": x["category_subtype"][0] if x.get("category_subtype") else None, "reps": x.get("repetitions"),
        "weight_kg": r(x["weight"], 1) if x.get("weight") is not None else None, "duration_s": r(x.get("duration"), 0),
    } for n, x in enumerate(fit["sets"])] or None

    # Pauses (timer stopped) and standing still with the timer running.
    t_first = pts[0]["ts"] if pts else None
    res["pauses"] = []
    for a, b2 in pauses:
        k = next((n for n, p in enumerate(pts) if p["ts"] >= a), -1)
        res["pauses"].append({"at_elapsed_min": r((a - (t_first if t_first is not None else a)) / 60000, 1), "at_km": r(pts[k]["d"] / 1000, 2) if k >= 0 else None,
                              "duration_s": r((b2 - a) / 1000, 0)})
    still = []
    if foot:
        s = None
        for n in range(1, len(pts)):
            slow = pts[n]["speed"] is not None and pts[n]["speed"] < 0.5
            if slow and s is None:
                s = n
            if (not slow or n == len(pts) - 1) and s is not None:
                dur = pts[n]["mt"] - pts[s]["mt"]
                if dur >= 15:
                    still.append({"at_km": r(pts[s]["d"] / 1000, 2), "duration_s": r(dur, 0)})
                s = None
    res["standing_still"] = still

    res["best_efforts"] = _best_efforts(pts, foot)
    res["best_power_w"] = _best_power(pts)

    # Analysis: totals, HR drift / decoupling (after a 5-min warm-up), efficiency factor, zones, variability.
    al = _agg(pts, 0, len(pts) - 1) if len(pts) > 1 else None
    dist = pts[-1]["d"] - pts[0]["d"] if pts else 0
    avg_speed = dist / moving if moving > 0 else None
    warm = min(300, moving * 0.1)
    steady = [p for p in pts if p["mt"] >= warm]
    decoupling = drift = None
    if len(steady) > 60 and moving - warm >= 600:
        mid = (steady[0]["mt"] + steady[-1]["mt"]) / 2

        def half(second):
            g = [p for p in steady if (p["mt"] >= mid) == second]
            out = [(p["pwr"] if sport == "cycling" else (p.get("gap") if p.get("gap") is not None else p["speed"])) for p in g]
            return mean([p["hr"] for p in g]), mean(out)

        hr1, out1 = half(False)
        hr2, out2 = half(True)
        if hr1 and hr2 and out1 and out2:
            ef1, ef2 = out1 / hr1, out2 / hr2
            decoupling, drift = r((ef1 - ef2) / ef1 * 100), r(hr2 - hr1, 0)
    hr_avg = al["avg"]("hr") if al else None
    gap_avg = mean([p.get("gap") for p in pts])
    zone_time = None
    if zones and len(zones) == 5:
        z = [0.0] * 6
        for n in range(1, len(pts)):
            hr, dt = pts[n]["hr"], pts[n]["mt"] - pts[n - 1]["mt"]
            if hr is None or dt <= 0:
                continue
            k = 0
            while k < 5 and hr >= zones[k]:
                k += 1
            z[k] += dt
        zone_time = {"below_z1_min": r(z[0] / 60), "z1_min": r(z[1] / 60), "z2_min": r(z[2] / 60), "z3_min": r(z[3] / 60), "z4_min": r(z[4] / 60),
                     "z5_min": r(z[5] / 60), "floors_bpm": zones}
    full = [x for x in splits if not x["partial"] and x["time_s"]]
    paces = [x["time_s"] for x in full]
    first_half, second_half = full[:len(full) // 2], full[math.ceil(len(full) / 2):]
    avg_pwr = al["avg"]("pwr") if al else None
    stamina = [p.get("stamina") for p in pts]
    bb = [p.get("body_battery") for p in pts]
    has = lambda k: bool(extras and k in extras["cols"])  # noqa: E731
    res["analysis"] = {
        "sport": sport, "distance_km": r(dist / 1000, 2), "moving_time": fmt_time(moving), "elapsed_time": fmt_time(pts[-1]["el"]) if pts else None,
        "paused_s": r(sum((b2 - a) / 1000 for a, b2 in pauses), 0),
        "avg_pace_min_km": pace_str(pace_of(avg_speed)) if foot else None, "avg_speed_kmh": r(avg_speed * 3.6) if not foot and avg_speed else None,
        "grade_adjusted_pace_min_km": pace_str(pace_of(gap_avg)) if foot and gap_avg else None,
        "avg_hr": r(hr_avg, 0), "max_hr": al["max_hr"] if al else None, "avg_power": r(avg_pwr, 0), "normalized_power": _normalized_power(pts),
        "efficiency_factor": (r(avg_pwr / hr_avg, 2) if sport == "cycling" and avg_pwr else r(avg_speed * 60 / hr_avg, 2)) if hr_avg and avg_speed else None,
        "efficiency_factor_note": "watts per beat" if sport == "cycling" else "metres per minute per beat (higher = fitter at the same effort)",
        "efficiency_factor_grade_adjusted": r(gap_avg * 60 / hr_avg, 2) if foot and hr_avg and gap_avg else None,
        "decoupling_pct": decoupling, "hr_drift_bpm": drift,
        "decoupling_note": "Needs at least 10 minutes after a 5-minute warm-up." if decoupling is None else
        f"{'Power' if sport == 'cycling' else 'Pace'}:HR change, second half vs first half (after warm-up). Under 5% on a steady effort = good aerobic fitness; "
        "only meaningful if the effort was steady.",
        "negative_split_s_per_km": r(mean([x["time_s"] for x in second_half]) - mean([x["time_s"] for x in first_half]), 0) if first_half and second_half else None,
        "km_pace_variability_pct": r(stdev(paces) / mean(paces) * 100) if len(paces) >= 3 else None,
        "avg_cadence": r(al["avg"]("cad"), 0) if al else None, "cadence_sd": r(stdev([p["cad"] for p in pts if p["cad"] is not None and p["cad"] > 0]), 1),
        "avg_stride_m": r(al["avg"]("stride"), 2) if al else None, "avg_vertical_oscillation_cm": r(al["avg"]("vo")) if al else None,
        "avg_vertical_ratio_pct": r(al["avg"]("vr")) if al else None, "avg_ground_contact_ms": r(al["avg"]("gct"), 0) if al else None,
        "avg_gct_balance_left_pct": r(al["avg"]("gct_bal")) if al else None,
        "elev_gain_m": r(al["up"], 0) if al else None, "elev_loss_m": r(al["down"], 0) if al else None, "avg_temperature_c": r(al["avg"]("temp")) if al else None,
        "stamina_start_pct": first_num(stamina) if has("stamina") else None, "stamina_end_pct": first_num(stamina[::-1]) if has("stamina") else None,
        "body_battery_start": first_num(bb) if has("body_battery") else None, "body_battery_end": first_num(bb[::-1]) if has("body_battery") else None,
        "hr_zones": zone_time, "pauses": len(res["pauses"]), "standing_still_stops": len(still),
    }
    return res


LABEL = {"speed": "pace_min_km", "hr": "hr_bpm", "cad": "cadence", "pwr": "power_w", "alt": "altitude_m", "vo": "vertical_oscillation_cm", "gct": "ground_contact_ms",
         "gct_bal": "gct_balance_left_pct", "vr": "vertical_ratio_pct", "stride": "stride_m", "temp": "temperature_c", "resp": "respiration_brpm",
         "perf": "performance_condition", "gap": "grade_adjusted_pace_min_km", "stamina": "stamina_pct", "stamina_potential": "stamina_potential_pct",
         "body_battery": "body_battery", "performance_condition": "performance_condition_garmin", "vertical_speed": "vertical_speed_m_s",
         "respiration": "respiration_brpm_garmin"}


def downsample(series, n=120, channels=None, foot=True):
    """A stored series to about n rows (averages per bucket), with the columns listed once."""
    length = len(series["t_s"])
    if not length:
        return {"columns": [], "rows": []}
    keep = [k for k in series if k not in ("step_s", "t_s", "elapsed_s", "km") and (not channels or k in channels)]
    per = max(1, math.ceil(length / max(10, min(2000, n))))
    columns = ["min", "km"] + [("speed_kmh" if k == "speed" and not foot else LABEL.get(k, k)) for k in keep]
    rows = []
    for i in range(0, length, per):
        j = min(length, i + per)
        row = [r(series["t_s"][i] / 60, 1), series["km"][j - 1]]
        for k in keep:
            v = [x for x in series[k][i:j] if x is not None]
            v = sum(v) / len(v) if v else None
            if k == "gap" or (k == "speed" and foot):
                row.append(pace_str(pace_of(v)))
            elif k == "speed":
                row.append(r(v * 3.6, 1) if v is not None else None)
            else:
                row.append(r(v, 2 if k == "stride" else 1))
        rows.append(row)
    return {"columns": columns, "rows": rows, "every_s": per * series["step_s"],
            "note": "min = moving minutes; pace columns are min:sec per km; null = not recorded"}
