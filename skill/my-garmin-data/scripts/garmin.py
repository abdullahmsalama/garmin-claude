#!/usr/bin/env python3
"""Read-only access to your own Garmin Connect data through Garmin's official Personal API.

What this file does, in full:
  * reads your Personal API key from key.txt (next to SKILL.md) or the GARMIN_API_KEY variable
  * trades it for a 24-hour access token at Garmin, kept in a temp file for this chat only
  * makes GET requests to personal.connectapi.garmin.com and prints tidy JSON
It never writes to Garmin, never contacts any other address, and never prints your key.
Python standard library only: nothing to install.

Usage:  python3 garmin.py <command> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
Commands: check, overview, activities [--type running], activity <id>, daily, sleep, hrv,
          body-battery, weight, hr-zones, fitness-age,
          inside one workout: splits <id>, analyze <id>, streams <id> [--points 120] [--channels hr,pace],
          strength [<id>], day [--date YYYY-MM-DD] [--every 15], records [--type running],
          trends [--type running] [--by week|month], profile [--weeks 26]
Inside-a-workout commands download the activity's original file from Garmin and decode it here
(fit.py, analysis.py); the result is kept in a temp file for this chat only.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analysis import ANALYSIS_VERSION, RIDE_DISTANCES, RUN_DISTANCES, analyze, chart_extras, downsample, fmt_time, pace_str  # noqa: E402
from fit import FitError, decode_fit, fit_from_download  # noqa: E402

BASE = os.environ.get("GARMIN_BASE", "https://personal.connectapi.garmin.com")  # override only for tests
HOST = urllib.parse.urlparse(BASE).hostname
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
HERE = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(os.path.dirname(HERE), "key.txt")
TOKEN_CACHE = os.path.join(tempfile.gettempdir(), "garmin-skill-token.json")
MAX_DAYS = {"activities": 31, "daily": 120, "sleep": 31, "hrv": 31, "body-battery": 31, "weight": 120}  # Garmin's per-request limits


class GarminError(Exception):
    pass


# ---------- key and token ----------
def api_key():
    key = os.environ.get("GARMIN_API_KEY", "").strip()
    if not key and os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            key = f.read().strip()
    if not key or key.startswith("PASTE"):
        raise GarminError("No Garmin key yet. Put your Personal API key in key.txt inside the skill (or use the skill maker page) and upload the skill again.")
    return key


def request(method, path, headers, params=None, raw=False):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60 if raw else 40) as r:
            body = r.read()
            return r.status, body if raw else body.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise GarminError(
            f"Can't reach {HOST} ({e.reason}). In Claude: Settings > Capabilities > code execution, allow network access to "
            f"the domain {HOST}, then start a new chat."
        )


def token(force=False):
    if not force and os.path.exists(TOKEN_CACHE):
        try:
            with open(TOKEN_CACHE) as f:
                c = json.load(f)
            if c.get("exp", 0) > time.time() + 300 and c.get("base") == BASE:
                return c["token"]
        except (OSError, ValueError):
            pass
    # Garmin answers 406 if we ask for JSON here, so accept anything.
    status, text = request("POST", TOKEN_PATH, {"Authorization": "ApiKey " + api_key(), "Accept": "*/*"})
    if status in (401, 403):
        raise GarminError("Garmin refused the key. It may be expired or deleted: make a new one in Garmin Connect > Settings > Personal API Key.")
    if status >= 400:
        raise GarminError(f"Garmin token request failed ({status}).")
    try:
        j = json.loads(text)
    except ValueError:
        j = {"access_token": text.strip()}
    if isinstance(j, str):
        j = {"access_token": j}
    tok = j.get("access_token") or j.get("accessToken") or j.get("token") or (j.get("data") or {}).get("access_token")
    if not tok:
        raise GarminError("Garmin's token answer had no token.")
    ttl = float(j.get("expires_in") or j.get("expiresIn") or 86400)
    try:
        with open(TOKEN_CACHE, "w") as f:
            json.dump({"token": tok, "exp": time.time() + ttl, "base": BASE}, f)
        os.chmod(TOKEN_CACHE, 0o600)
    except OSError:
        pass
    return tok


def get(path, params=None, retried=False):
    status, text = request("GET", path, {"Authorization": "Bearer " + token(retried), "Accept": "application/json"}, params)
    if status == 401 and not retried:
        return get(path, params, True)
    if status >= 400:
        raise GarminError(f"Garmin {path.split('?')[0]} answered {status}.", status)
    return json.loads(text) if text.strip() else None


def get_bytes(path, retried=False):
    status, body = request("GET", path, {"Authorization": "Bearer " + token(retried), "Accept": "*/*"}, raw=True)
    if status == 401 and not retried:
        return get_bytes(path, True)
    if status == 404:
        raise GarminError("Garmin has no file for this activity (manual entries have none).")
    if status >= 400:
        raise GarminError(f"Garmin activity file answered {status}.", status)
    return body


def try_get(path, params=None):
    """Like get, but a failure becomes {"__error": ...} (for pages that combine several sources)."""
    try:
        return get(path, params)
    except GarminError as e:
        return {"__error": str(e)}


# ---------- dates ----------
def day(s):
    return dt.date.fromisoformat(s)


def chunks(frm, to, size):
    a, b = day(frm), day(to)
    while a <= b:
        e = min(b, a + dt.timedelta(days=size - 1))
        yield a.isoformat(), e.isoformat()
        a = e + dt.timedelta(days=1)


def date_range(args, default_days=7, max_days=366):
    to = args.to or dt.date.today().isoformat()
    frm = args.frm or (day(to) - dt.timedelta(days=default_days - 1)).isoformat()
    if frm > to:
        raise GarminError('"from" is after "to".')
    if (day(to) - day(frm)).days > max_days:
        frm = (day(to) - dt.timedelta(days=max_days)).isoformat()
    return frm, to


# ---------- tidy numbers ----------
def clean(d):
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def r1(v):
    return None if v is None else round(float(v), 1)


def r2(v):
    return None if v is None else round(float(v), 2)


def minutes(s):
    return None if s is None else r1(s / 60)


def km(m):
    return None if m is None else r2(m / 1000)


def pace(mps):
    if not mps or mps <= 0.3:
        return None
    s = round(1000 / mps)
    return f"{s // 60}:{s % 60:02d}"


def local(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.utcfromtimestamp(v / 1000).strftime("%Y-%m-%d %H:%M")
    return str(v).replace("T", " ")[:16]


def label(v):
    return v.lower() if isinstance(v, str) and v and not re.match(r"^(unknown|none|no_data)$", v, re.I) else None


def low(v):
    return v.lower() if isinstance(v, str) else None


def is_run(t):
    return bool(re.search(r"run|walk|hik|treadmill|track", t or "", re.I))


def mean(xs):
    v = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(v) / len(v), 1) if v else None


# ---------- Garmin objects -> small objects ----------
def activity(a):
    t = (a.get("activityType") or {}).get("typeKey")
    dur = a.get("movingDuration") or a.get("duration")
    zones = [a.get(f"hrTimeInZone_{i}") for i in range(1, 6)]
    return clean({
        "id": str(a["activityId"]) if a.get("activityId") is not None else None,
        "date": (a.get("startTimeLocal") or "")[:10] or None,
        "start": local(a.get("startTimeLocal")),
        "type": t, "name": a.get("activityName"),
        "km": km(a.get("distance")), "min": minutes(dur),
        "pace_min_km": pace(a["distance"] / dur if a.get("distance") and dur else a.get("averageSpeed")) if is_run(t) else None,
        "speed_kmh": r1(a["averageSpeed"] * 3.6) if not is_run(t) and a.get("averageSpeed") else None,
        "avg_hr_bpm": round(a["averageHR"]) if a.get("averageHR") is not None else None,
        "max_hr_bpm": round(a["maxHR"]) if a.get("maxHR") is not None else None,
        "cadence_spm": round(a["averageRunningCadenceInStepsPerMinute"]) if a.get("averageRunningCadenceInStepsPerMinute") else None,
        "climb_m": round(a["elevationGain"]) if a.get("elevationGain") is not None else None,
        "kcal": round(a["calories"]) if a.get("calories") is not None else None,
        "avg_power_w": round(a["avgPower"]) if a.get("avgPower") is not None else None,
        "training_load": round(a["activityTrainingLoad"]) if a.get("activityTrainingLoad") is not None else None,
        "aerobic_te": r1(a.get("aerobicTrainingEffect")), "anaerobic_te": r1(a.get("anaerobicTrainingEffect")),
        "te_label": label(a.get("trainingEffectLabel")),
        "vo2max": a.get("vO2MaxValue") or None,
        "hr_zones_min": {f"z{i + 1}": minutes(z or 0) for i, z in enumerate(zones)} if any(z is not None for z in zones) else None,
        "stride_cm": r1(a.get("avgStrideLength")) if a.get("avgStrideLength") else None,
        "ground_contact_ms": round(a["avgGroundContactTime"]) if a.get("avgGroundContactTime") else None,
        "vertical_osc_cm": r1(a.get("avgVerticalOscillation")) if a.get("avgVerticalOscillation") else None,
        "is_pr": a.get("isPR") or None,
    })


def activity_detail(d, workouts):
    s = d.get("summaryDTO") or {}
    t = (d.get("activityTypeDTO") or {}).get("typeKey")
    rpe = s.get("directWorkoutRpe")
    splits = []
    for x in d.get("splitSummaries") or []:
        if not x.get("splitType"):
            continue
        dur = x.get("movingDuration") or x.get("duration")
        splits.append(clean({
            "type": x["splitType"].lower(), "count": x.get("noOfSplits"), "km": km(x.get("distance")), "min": minutes(dur),
            "pace_min_km": pace(x["distance"] / dur if x.get("distance") and dur else x.get("averageSpeed")) if is_run(t) else None,
            "avg_hr_bpm": round(x["averageHR"]) if x.get("averageHR") is not None else None,
        }))
    steps = []
    for w in workouts if isinstance(workouts, list) else []:
        steps.append(clean({"name": w.get("workoutName"), "sport": w.get("sport"), "steps": [clean({
            "step": st.get("stepIndex"), "name": st.get("name"), "intensity": low(st.get("intensity")),
            "duration": step_duration(st), "target": step_target(st), "notes": st.get("notes"),
        }) for st in w.get("steps") or []]}))
    return clean({
        "description": d.get("description"), "location": d.get("locationName"),
        "recovery_hr_bpm": s.get("recoveryHeartRate"), "lactate_threshold_hr_bpm": s.get("lactateThresholdHeartRate"),
        "grade_adjusted_pace_min_km": pace(s.get("avgGradeAdjustedSpeed")) if is_run(t) else None,
        "rpe_1_10": (rpe / 10 if rpe > 10 else rpe) if rpe is not None else None,
        "body_battery_change": s.get("differenceBodyBattery"),
        "avg_respiration_brpm": r1(s.get("avgRespirationRate")),
        "stamina_start_pct": s.get("beginPotentialStamina"), "stamina_end_pct": s.get("endPotentialStamina"),
        "temp_c": r1(s.get("averageTemperature")),
        "split_summaries": splits, "planned_workout": steps,
    })


def step_duration(st):
    t, v = str(st.get("durationType") or "").lower(), st.get("durationValue")
    if not t:
        return None
    if v is not None and "time" in t:
        return f"{r1(v / 60)} min"
    if v is not None and "distance" in t:
        return f"{r2(v / 1000)} km"
    return f"{v} {t}" if v is not None else t


def step_target(st):
    t = str(st.get("targetType") or "").lower()
    if not t or re.search(r"no[._ ]?target|open", t):
        return None
    if re.search(r"pace|speed", t) and (st.get("targetValueLow") or st.get("targetValueHigh")):
        speeds = sorted([x for x in (st.get("targetValueLow"), st.get("targetValueHigh")) if x], reverse=True)  # faster first
        return clean({"type": "pace", "pace_min_km": "-".join(p for p in (pace(x) for x in speeds) if p)})
    return clean({"type": t, "value": st.get("targetValue"), "low": st.get("targetValueLow"), "high": st.get("targetValueHigh")})


def daily(d):
    m, c, hr, im, st, bb = (d.get(k) or {} for k in ("movement", "calories", "heartRate", "intensityMinutes", "stress", "bodyBattery"))
    steps = m.get("steps") or {}
    ms = lambda v: None if v is None else r1(v / 60000)  # noqa: E731
    return clean({
        "date": d.get("calendarDate"), "steps": steps.get("value"), "km": km(steps.get("distanceInMeters")),
        "floors": round((m.get("floorsAscended") or {}).get("value")) if (m.get("floorsAscended") or {}).get("value") is not None else None,
        "active_kcal": round(c["burnedActive"]) if c.get("burnedActive") is not None else None,
        "total_kcal": round(c["burnedTotal"]) if c.get("burnedTotal") is not None else None,
        "resting_hr_bpm": hr.get("restingValue"), "min_hr_bpm": hr.get("minValue"), "max_hr_bpm": hr.get("maxValue"),
        "moderate_min": im.get("moderate"), "vigorous_min": im.get("vigorous"),
        "avg_stress": st.get("avgLevel") if (st.get("avgLevel") or -1) >= 0 else None,
        "max_stress": st.get("maxLevel") if (st.get("maxLevel") or -1) >= 0 else None,
        "stress_qualifier": label(st.get("qualifier")),
        "rest_min": ms(st.get("restDurationInMillis")), "low_stress_min": ms(st.get("lowStressDurationInMillis")),
        "medium_stress_min": ms(st.get("mediumStressDurationInMillis")), "high_stress_min": ms(st.get("highStressDurationInMillis")),
        "body_battery_high": bb.get("maxValue"), "body_battery_low": bb.get("minValue"),
        "body_battery_charged": bb.get("chargedValue"), "body_battery_drained": bb.get("drainedValue"),
        "body_battery_end": bb.get("endOfDayValue", bb.get("latestValue")),
        "respiration_brpm": r1((d.get("respiration") or {}).get("avgValue")), "spo2_pct": (d.get("pulseOx") or {}).get("avgValue"),
    })


def sleep(s):
    sc = s.get("sleepScores") or {}
    overall = sc.get("overall") or {}
    need = s.get("sleepNeed")
    return clean({
        "date": s.get("calendarDate"), "start": local(s.get("sleepStartTimestampLocal")), "end": local(s.get("sleepEndTimestampLocal")),
        "total_min": minutes(s.get("sleepTimeSeconds")), "deep_min": minutes(s.get("deepSleepSeconds")),
        "light_min": minutes(s.get("lightSleepSeconds")), "rem_min": minutes(s.get("remSleepSeconds")),
        "awake_min": minutes(s.get("awakeSleepSeconds")), "awake_count": s.get("awakeCount"),
        "nap_min": minutes(s.get("napTimeSeconds")) if s.get("napTimeSeconds") else None,
        "score": overall.get("value", (sc.get("totalScore") or {}).get("value")), "quality": low(overall.get("qualifierKey")),
        "feedback": low(s.get("sleepScoreFeedback")),
        "avg_hr_bpm": round(s["avgHeartRate"]) if s.get("avgHeartRate") is not None else None,
        "avg_stress": r1(s.get("avgSleepStress")), "respiration_brpm": r1(s.get("averageRespirationValue")),
        "spo2_pct": s.get("averageSpO2Value"),
        "need_min": need if isinstance(need, (int, float)) else (need or {}).get("actual"),
    })


def hrv(h):
    b = h.get("baseline") or {}
    return clean({
        "date": h.get("calendarDate"), "last_night_avg_ms": h.get("lastNightAvg"), "last_night_5min_high_ms": h.get("lastNight5MinHigh"),
        "weekly_avg_ms": h.get("weeklyAvg"), "status": low(h.get("status")),
        "baseline_low_ms": b.get("balancedLow"), "baseline_high_ms": b.get("balancedUpper"), "feedback": low(h.get("feedbackPhrase")),
    })


def body_battery(b):
    keys = [x["bodyBatteryValueDescriptorKey"] for x in sorted(b.get("bodyBatteryValueDescriptorDTOList") or [], key=lambda x: x["bodyBatteryValueDescriptorIndex"])]
    rows = [dict(zip(keys, r)) for r in b.get("bodyBatteryValuesArray") or []]
    levels = [[v for k, v in r.items() if isinstance(v, (int, float)) and not re.search(r"time|stamp", k, re.I)] for r in rows]
    levels = [x for x in levels if x]
    allv = [v for x in levels for v in x if 0 <= v <= 100]
    fb = b.get("bodyBatteryDynamicFeedbackEvent") or {}
    return clean({
        "date": b.get("date"), "charged": b.get("charged"), "drained": b.get("drained"),
        "start": levels[0][0] if levels else None, "end": levels[-1][-1] if levels else None,
        "high": max(allv) if allv else None, "low": min(allv) if allv else None,
        "feedback": low(fb.get("feedbackLongType") or fb.get("feedbackShortType")),
        "events": [clean({"type": low(e.get("eventType")), "start": local(e.get("eventStartTimeGmt")),
                          "min": r1(e["durationInMilliseconds"] / 60000) if e.get("durationInMilliseconds") else None,
                          "impact": e.get("bodyBatteryImpact")}) for e in b.get("bodyBatteryActivityEvent") or []],
    })


def kg(v):
    return None if v is None else r1(v / 1000 if v > 1000 else v)  # Garmin may send grams


def weight(w):
    return clean({
        "date": w.get("calendarDate") or (w.get("date") if isinstance(w.get("date"), str) else None),
        "weight_kg": kg(w.get("weight")), "bmi": r1(w.get("bmi")), "body_fat_pct": r1(w.get("bodyFat")),
        "body_water_pct": r1(w.get("bodyWater")), "muscle_kg": kg(w.get("muscleMass")), "bone_kg": kg(w.get("boneMass")),
        "visceral_fat": w.get("visceralFat"), "metabolic_age": w.get("metabolicAge"),
    })


# ---------- commands ----------
def fetch_chunked(kind, frm, to, fn):
    out = []
    for a, b in chunks(frm, to, MAX_DAYS[kind]):
        out.extend(fn(a, b) or [])
    return out


def raw_activities(frm, to):
    def page(a, b):
        res, start = [], 0
        while start < 2000:
            p = get("/activitylist-service/activities/search/activities", {"startDate": a, "endDate": b, "start": start, "limit": 99, "sortOrder": "asc"})
            if not isinstance(p, list):
                break
            res.extend(p)
            if len(p) < 99:
                break
            start += 99
        return res
    return fetch_chunked("activities", frm, to, page)


def get_activities(frm, to):
    return [activity(a) for a in raw_activities(frm, to)]


def get_daily(frm, to):
    return [daily(d) for d in fetch_chunked("daily", frm, to, lambda a, b: (get("/usersummary-service/v2/dailysummaries", {"startDate": a, "endDate": b}) or {}).get("data"))]


def get_sleep(frm, to):
    nights = fetch_chunked("sleep", frm, to, lambda a, b: get("/sleep-service/sleep/dailySleepSummariesByDate", {"startDate": a, "endDate": b}))
    return [n for n in (sleep(s) for s in nights) if n.get("total_min")]


def get_hrv(frm, to):
    return [hrv(h) for h in fetch_chunked("hrv", frm, to, lambda a, b: (get(f"/hrv-service/hrv/daily/{a}/{b}") or {}).get("hrvSummaries"))]


def get_bb(frm, to):
    return [body_battery(b) for b in fetch_chunked("body-battery", frm, to, lambda a, b: get("/wellness-service/wellness/bodyBattery/reports/daily", {"startDate": a, "endDate": b}))]


def get_weight(frm, to):
    def one(a, b):
        try:
            return get(f"/weight-service/weight/all/{a}/{b}")
        except GarminError as e:  # Garmin refuses some ranges with an empty 400; the "range" endpoint works then
            if "400" not in str(e):
                raise
            r = get(f"/weight-service/weight/range/{a}/{b}", {"includeAll": "true"}) or {}
            return [m for d in r.get("dailyWeightSummaries") or [] for m in (d.get("allWeightMetrics") or ([d["latestWeight"]] if d.get("latestWeight") else []))]
    seen, out = set(), []
    for w in fetch_chunked("weight", frm, to, one):
        k = w.get("samplePk") or (w.get("calendarDate"), w.get("weight"), w.get("timestampGMT"))
        if k not in seen:
            seen.add(k)
            out.append(weight(w))
    return sorted(out, key=lambda x: x.get("date") or "")


# ---------- inside one workout, one day, and over time ----------
CACHE_DIR = os.path.join(tempfile.gettempdir(), "garmin-skill-cache")
FOOT = re.compile(r"run|walk|hik|trail|track|treadmill|obstacle")
CHANNELS = {"pace": "speed", "speed": "speed", "hr": "hr", "heart_rate": "hr", "cadence": "cad", "power": "pwr", "altitude": "alt", "vertical_oscillation": "vo",
            "ground_contact": "gct", "gct_balance": "gct_bal", "vertical_ratio": "vr", "stride": "stride", "temperature": "temp", "respiration": "resp",
            "performance_condition": "perf", "grade_adjusted_pace": "gap", "stamina": "stamina", "stamina_potential": "stamina_potential",
            "body_battery": "body_battery", "vertical_speed": "vertical_speed"}


def type_of(a):
    return (a.get("activityType") or {}).get("typeKey") or ""


def cache_path(name):
    os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
    tag = hashlib.sha256(BASE.encode()).hexdigest()[:8]  # tests use another base
    return os.path.join(CACHE_DIR, f"{tag}-{name}.json")


def cached(name, max_age_s, fn):
    """fn() once per chat (temp file), refreshed after max_age_s."""
    path = cache_path(name)
    try:
        if time.time() - os.path.getmtime(path) < max_age_s:
            with open(path) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    v = fn()
    try:
        with open(path, "w") as f:
            json.dump(v, f)
    except OSError:
        pass
    return v


def settings():
    s = cached("settings", 6 * 3600, lambda: try_get("/userprofile-service/userprofile/settings") or {})
    return s if isinstance(s, dict) and "__error" not in s else {}


def user_tz():
    """The time zone set in Garmin Connect (falls back to UTC)."""
    name = settings().get("timeZone")
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name), name
    except Exception:  # no zone set, or no time-zone data on this machine
        return dt.timezone.utc, "UTC"


def gmt_ms(v):
    """Garmin GMT time (epoch ms, or "2026-10-27T21:30:00.0" without a zone) -> epoch ms."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?", str(v))
    if not m:
        return None
    d = dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4) or '00'}").replace(tzinfo=dt.timezone.utc)
    return d.timestamp() * 1000


def in_tz(ms, tz):
    return None if ms is None else dt.datetime.fromtimestamp(ms / 1000, tz).strftime("%Y-%m-%d %H:%M")


def hr_zones_raw():
    z = cached("hr-zones", 6 * 3600, lambda: try_get("/biometric-service/heartRateZones/v2") or [])
    return z if isinstance(z, list) else []


def zone_floors(sport_key):
    """HR zone floors for a sport (running zones for runs if set, else the default ones)."""
    lst = hr_zones_raw()
    want = "RUNNING" if re.search("run", sport_key or "") else "CYCLING" if re.search("cycl|bik|ride", sport_key or "") else "DEFAULT"
    pick = next((x for x in lst if x.get("sport") == want), None) or next((x for x in lst if x.get("sport") == "DEFAULT"), None) or (lst[0] if lst else None)
    f = [pick.get(f"zone{i}Floor") for i in range(1, 6)] if pick else None
    return f if f and all(isinstance(v, (int, float)) for v in f) else None


def activity_analysis(aid):
    """Everything inside one workout: its original file, decoded and analysed here (kept for this chat)."""
    aid = re.sub(r"\D", "", aid or "")
    if not aid:
        raise GarminError("Give an activity id (from the activities command).")
    path = cache_path(f"analysis-{aid}")
    try:
        with open(path) as f:
            a = json.load(f)
        if a.get("v") == ANALYSIS_VERSION:
            return a
    except (OSError, ValueError):
        pass
    d = get(f"/activity-service/activity/{aid}") or {}
    s = d.get("summaryDTO") or {}
    try:
        fit = decode_fit(fit_from_download(get_bytes(f"/download-service/files/activity/{aid}")))
    except FitError as e:
        raise GarminError(f"Couldn't read the activity file: {e}.")
    details = try_get(f"/activity-service/activity/{aid}/details", {"maxChartSize": 2000, "maxPolylineSize": 0})
    type_key = (d.get("activityTypeDTO") or {}).get("typeKey")
    a = analyze(fit, extras=chart_extras(details if isinstance(details, dict) and "__error" not in details else None), zones=zone_floors(type_key))
    tz, _ = user_tz()
    a.update({
        "id": aid, "name": d.get("activityName"), "type": type_key or a["sport"],
        "start_local": local(s.get("startTimeLocal")) or in_tz((fit["sessions"][0].get("start_time") if fit["sessions"] else None) or (fit["records"][0]["timestamp"] if fit["records"] else None), tz),
        "garmin_summary": clean({"distance_km": km(s.get("distance")), "moving_s": s.get("movingDuration") or s.get("duration"),
                                 "avg_hr": s.get("averageHR")}) or None,
        "summarized_exercise_sets": d.get("summarizedExerciseSets") or s.get("summarizedExerciseSets"),
    })
    try:
        with open(path, "w") as f:
            json.dump(a, f)
    except OSError:
        pass
    return a


def g_kg(v):
    return None if v is None else r1(v / 1000 if v > 1000 else v)  # Garmin gives grams


def summarize_sets(sets):
    if not isinstance(sets, list) or not sets:
        return None
    return [{"exercise": str(e.get("category") or e.get("subCategory") or "unknown").lower(), "sub": str(e["subCategory"]).lower() if e.get("subCategory") else None,
             "sets": e.get("sets"), "reps": e.get("reps"), "volume_kg": g_kg(e.get("volume")), "max_weight_kg": g_kg(e.get("maxWeight")),
             "duration_s": round(e["duration"] / 1000 if e["duration"] > 10000 else e["duration"]) if e.get("duration") is not None else None} for e in sets]


def week_start(d):
    x = day(d)
    return (x - dt.timedelta(days=x.weekday())).isoformat()


def desc_index(lst, key):
    """Index of `key` in a Garmin descriptor list ([{...Key: name, ...Index: n}])."""
    for x in lst or []:
        if any(re.search("key$", k, re.I) and str(v).lower() == key.lower() for k, v in x.items()):
            for k, v in x.items():
                if re.search("index$", k, re.I):
                    return v
    return -1


def pick_series(rows, desc, names, rng, tz):
    """Rows described by a descriptor list -> [["HH:MM", value]]. Uses the named column if present, otherwise
    the non-time column whose values fall in `rng` most often (Garmin's key names vary)."""
    rows = [x for x in rows or [] if isinstance(x, list)]
    if not rows:
        return []
    ti = desc_index(desc, "timestamp")
    ti = 0 if ti < 0 else ti
    vi = -1
    for n in names:
        vi = desc_index(desc, n)
        if vi >= 0:
            break
    if vi < 0:
        best = -1
        for c in range(len(rows[0])):
            if c == ti:
                continue
            n = sum(1 for x in rows if len(x) > c and isinstance(x[c], (int, float)) and rng[0] <= x[c] <= rng[1])
            if n > best:
                best, vi = n, c
    out = []
    for x in rows:
        if len(x) > max(ti, vi) and x[ti] is not None and isinstance(x[vi], (int, float)) and rng[0] <= x[vi] <= rng[1]:
            t = in_tz(gmt_ms(x[ti]), tz)
            out.append([t[11:] if t else None, x[vi]])
    return out


def group_curve(lst, every):
    b = {}
    for t, v in lst or []:
        if not t:
            continue
        h, m = map(int, t.split(":")[:2])
        b.setdefault((h * 60 + m) // every * every, []).append(v)
    return [[f"{k // 60:02d}:{k % 60:02d}", round(min(v)), round(sum(v) / len(v)), round(max(v))] for k, v in sorted(b.items())]


def day_detail(date, every):
    tz, tzname = user_tz()
    ok = lambda v: v if v and not (isinstance(v, dict) and "__error" in v) else None  # noqa: E731
    sec = lambda v: None if v is None else r1(v / 60)  # noqa: E731
    msm = lambda v: None if v is None else r1(v / 60000)  # noqa: E731
    lw = lambda v: v.lower() if isinstance(v, str) else None  # noqa: E731
    src = {"heart_rate": try_get("/wellness-service/wellness/dailyHeartRate", {"date": date}), "hrv": try_get(f"/hrv-service/hrv/{date}"),
           "sleep": try_get("/sleep-service/sleep/dailySleep", {"date": date}), "summary": try_get("/usersummary-service/usersummary/daily", {"calendarDate": date}),
           "spo2": try_get(f"/wellness-service/wellness/daily/spo2acclimation/{date}")}
    # The plain Body Battery report has only a few points; asking for 96 chunks gives every 15 minutes.
    curve = try_get("/wellness-service/wellness/bodyBattery/reports/daily", {"startDate": date, "endDate": date, "chunks": 96})
    bb = curve[0] if isinstance(curve, list) and curve else None
    errors = [f"{k}: {v['__error']}" for k, v in {**src, "body_battery": curve}.items() if isinstance(v, dict) and "__error" in v]
    H, V, S, U, O = (ok(src[k]) for k in ("heart_rate", "hrv", "sleep", "summary", "spo2"))
    hm = lambda ms: (in_tz(ms, tz) or "")[11:] or None  # noqa: E731
    hr_series = [[hm(x[0]), x[1]] for x in (H or {}).get("heartRateValues") or [] if isinstance(x, list) and len(x) > 1 and x[1] is not None]
    bb_series = pick_series(bb.get("bodyBatteryValuesArray"), bb.get("bodyBatteryValueDescriptorDTOList"), ["bodyBatteryLevel"], (0, 100), tz) if bb else []
    hv = (V or {}).get("hrvSummary") or {}
    out = {"date": date, "time_zone": tzname}
    out["heart_rate"] = clean({"resting_bpm": H.get("restingHeartRate"), "min_bpm": H.get("minHeartRate"), "max_bpm": H.get("maxHeartRate"),
                               "resting_7d_avg_bpm": H.get("lastSevenDaysAvgRestingHeartRate"), "readings_count": len(hr_series),
                               "curve_columns": ["time", "min_bpm", "avg_bpm", "max_bpm"], "curve": group_curve(hr_series, every)}) if H else None
    out["hrv_overnight"] = clean({"avg_ms": hv.get("lastNightAvg"), "high_5min_ms": hv.get("lastNight5MinHigh"), "weekly_avg_ms": hv.get("weeklyAvg"),
                                  "status": lw(hv.get("status")), "baseline_low_ms": (hv.get("baseline") or {}).get("balancedLow"),
                                  "baseline_high_ms": (hv.get("baseline") or {}).get("balancedUpper"),
                                  "sleep_start": in_tz(gmt_ms(V.get("sleepStartTimestampGMT")), tz), "sleep_end": in_tz(gmt_ms(V.get("sleepEndTimestampGMT")), tz),
                                  "readings": [[hm(gmt_ms(x.get("readingTimeGMT"))), x["hrvValue"]] for x in V.get("hrvReadings") or [] if x and x.get("hrvValue") is not None]}) if V else None
    out["body_battery"] = clean({"charged": bb.get("charged"), "drained": bb.get("drained"), "curve_columns": ["time", "low", "avg", "high"], "curve": group_curve(bb_series, every),
                                 "events": [clean({"type": lw(e.get("eventType")), "start": in_tz(gmt_ms(e.get("eventStartTimeGmt")), tz), "min": msm(e.get("durationInMilliseconds")),
                                                   "impact": e.get("bodyBatteryImpact"), "feedback": lw(e.get("shortFeedback"))}) for e in bb.get("bodyBatteryActivityEvent") or []],
                                 "feedback": lw((bb.get("bodyBatteryDynamicFeedbackEvent") or {}).get("feedbackLongType")),
                                 "end_of_day_feedback": lw((bb.get("endOfDayBodyBatteryDynamicFeedbackEvent") or {}).get("feedbackLongType"))}) if bb else None
    out["spo2"] = clean({"avg_pct": O.get("averageSpO2"), "lowest_pct": O.get("lowestSpO2"), "sleep_avg_pct": O.get("avgSleepSpO2"), "last_7d_avg_pct": O.get("lastSevenDaysAvgSpO2"),
                         "hourly": pick_series(O.get("spO2HourlyAverages"), O.get("spO2HourlyAveragesDescriptorList"), ["spo2Reading", "spo2Value", "averageSpO2", "spo2"], (50, 100), tz),
                         "readings": pick_series(O.get("spO2SingleValues"), O.get("spO2SingleValuesDescriptorList"), ["spo2Reading", "spo2Value", "spo2"], (50, 100), tz)}) if O else None
    out["summary"] = clean({
        "steps": U.get("totalSteps"), "step_goal": U.get("dailyStepGoal"), "km": km(U.get("totalDistanceMeters")), "floors_up": U.get("floorsAscended"),
        "kcal_total": U.get("totalKilocalories"), "kcal_active": U.get("activeKilocalories"), "kcal_bmr": U.get("bmrKilocalories"),
        "highly_active_min": sec(U.get("highlyActiveSeconds")), "active_min": sec(U.get("activeSeconds")), "sedentary_min": sec(U.get("sedentarySeconds")),
        "sleeping_min": sec(U.get("sleepingSeconds")), "moderate_intensity_min": U.get("moderateIntensityMinutes"), "vigorous_intensity_min": U.get("vigorousIntensityMinutes"),
        "resting_hr_bpm": U.get("restingHeartRate"), "abnormal_hr_alerts": U.get("abnormalHeartRateAlertsCount"),
        "stress_avg": U["averageStressLevel"] if (U.get("averageStressLevel") or -1) >= 0 else None, "stress_max": U["maxStressLevel"] if (U.get("maxStressLevel") or -1) >= 0 else None,
        "stress_min": clean({k: msm(U.get(f"{k}StressDuration")) for k in ("rest", "low", "medium", "high", "activity", "uncategorized")}),
        "body_battery": clean({"high": U.get("bodyBatteryHighestValue"), "low": U.get("bodyBatteryLowestValue"), "at_wake": U.get("bodyBatteryAtWakeTime"),
                               "during_sleep_gain": U.get("bodyBatteryDuringSleep"), "latest": U.get("bodyBatteryMostRecentValue")}),
        "respiration_waking_avg_brpm": U.get("avgWakingRespirationValue"), "spo2_avg_pct": U.get("averageSpo2"), "hydration_ml": U.get("hydrationValueInML"),
    }) if U else None
    sc = (S or {}).get("sleepScores") or {}
    out["sleep"] = clean({
        "start": in_tz(gmt_ms(S.get("sleepStartTimestampGMT")), tz), "end": in_tz(gmt_ms(S.get("sleepEndTimestampGMT")), tz), "total_min": sec(S.get("sleepTimeSeconds")),
        "deep_min": sec(S.get("deepSleepSeconds")), "light_min": sec(S.get("lightSleepSeconds")), "rem_min": sec(S.get("remSleepSeconds")), "awake_min": sec(S.get("awakeSleepSeconds")),
        "awake_count": S.get("awakeCount"), "score": (sc.get("overall") or {}).get("value"), "quality": lw((sc.get("overall") or {}).get("qualifierKey")),
        "score_parts": {k: clean({"value": (v or {}).get("value"), "rating": lw((v or {}).get("qualifierKey"))}) for k, v in sc.items() if k != "overall" and isinstance(v, dict)},
        "feedback": lw(S.get("sleepScoreFeedback")), "insight": lw(S.get("sleepScoreInsight")), "avg_hr_bpm": S.get("avgHeartRate"), "avg_stress": S.get("avgSleepStress"),
        "respiration_avg_brpm": S.get("averageRespirationValue"), "spo2_avg_pct": S.get("averageSpO2Value"), "breathing_disruption": lw(S.get("breathingDisruptionSeverity")),
        "need_min": S["sleepNeed"] if isinstance(S.get("sleepNeed"), (int, float)) else (S.get("sleepNeed") or {}).get("actual"),
        "naps": [clean({"start": in_tz(gmt_ms(n.get("napStartTimestampGMT")), tz), "min": sec(n.get("napTimeSec"))}) for n in S.get("dailyNapDTOS") or []],
    }) if S and S.get("sleepTimeSeconds") is not None else None
    out["workouts"] = [{k: a.get(k) for k in ("id", "start", "type", "name", "km", "min", "avg_hr_bpm")} for a in get_activities(date, date)]
    out["not_available"] = "Garmin's API has no minute-by-minute stress, breathing rate, steps or sleep-stage timeline; those are daily totals only."
    if errors:
        out["errors"] = errors
    return out


def records(kind, frm, to):
    cycling = bool(re.search("cycl|bik|ride", kind or ""))
    acts = [a for a in raw_activities(frm, to) if (re.search("cycl|bik|ride", type_of(a)) if cycling else FOOT.search(type_of(a)))]
    keys = [] if cycling else [("1000", "1k", 1000), ("1609", "1mile", 1609.34), ("5000", "5k", 5000), ("10000", "10k", 10000), ("21098", "half_marathon", 21097.5), ("42195", "marathon", 42195)]
    efforts = {}
    for a in acts:
        for k, name, D in keys:
            t = a.get(f"fastestSplit_{k}")
            if t and t > 0:
                efforts.setdefault(name, {"meters": D, "list": []})["list"].append({"time_s": t, "date": (a.get("startTimeLocal") or "")[:10], "id": str(a.get("activityId")), "name": a.get("activityName")})
    since = (day(to) - dt.timedelta(days=90)).isoformat()
    best = lambda lst: min(lst, key=lambda e: e["time_s"]) if lst else None  # noqa: E731
    show = lambda e, D: {"time": fmt_time(e["time_s"]), "pace_min_km": pace_str(e["time_s"] / (D / 1000)), "date": e["date"], "id": e["id"], "name": e["name"]} if e else None  # noqa: E731
    rec = {n: {"best_in_range": show(best(v["list"]), v["meters"]), "last_90_days": show(best([e for e in v["list"] if e["date"] >= since]), v["meters"]),
               "top_3": [show(e, v["meters"]) for e in sorted(v["list"], key=lambda e: e["time_s"])[:3]]} for n, v in sorted(efforts.items(), key=lambda x: x[1]["meters"])}
    pred = None
    if not cycling:
        base = sorted([(v["meters"], n, best([e for e in v["list"] if e["date"] >= since])) for n, v in efforts.items() if v["meters"] >= 3000], key=lambda x: -x[0])
        base = next((b for b in base if b[2]), None)
        if base:
            D0, n0, e0 = base
            pred = {"based_on": f"{n0} {fmt_time(e0['time_s'])} on {e0['date']}", "method": "Riegel formula T2 = T1 x (D2/D1)^1.06: an ESTIMATE, assumes you trained for the distance",
                    **{n: {"time": fmt_time(e0["time_s"] * (D / D0) ** 1.06), "pace_min_km": pace_str(e0["time_s"] * (D / D0) ** 1.06 / (D / 1000))}
                       for n, D in (("5k", 5000), ("10k", 10000), ("half_marathon", 21097.5), ("marathon", 42195))}}
    return {"type": "cycling" if cycling else "running", "from": frm, "to": to, "activities_checked": len(acts), "records": rec, "race_predictions_estimated": pred,
            "note": "From Garmin's fastest splits in each activity in this date range (add --from for older years). 400 m, 3k and 15k best efforts inside a run come from the analyze command.",
            "not_available": "Garmin's official personal-records list and race predictor aren't in its API; these are computed from your activities."}


def trends(kind, frm, to, by):
    kind = (kind or "running").lower()
    lst = [a for a in raw_activities(frm, to) if kind == "all" or (re.search("run", type_of(a)) if kind == "running" else kind in type_of(a))]
    lz = hr_zones_raw()
    zp = next((x for x in lz if x.get("sport") == "RUNNING"), None) or next((x for x in lz if x.get("sport") == "DEFAULT"), None) or (lz[0] if lz else None)
    z2 = [zp["zone2Floor"], zp["zone3Floor"]] if zp and zp.get("zone2Floor") is not None and zp.get("zone3Floor") is not None else None
    groups = {}
    for a in lst:
        d = (a.get("startTimeLocal") or "")[:10]
        if d:
            groups.setdefault(d[:7] if by == "month" else week_start(d), []).append(a)

    def sp(a):
        dur = a.get("movingDuration") or a.get("duration")
        return a["distance"] / dur if a.get("distance") and dur else a.get("averageSpeed")

    def avg(vals, d=1):
        v = [x for x in vals if isinstance(x, (int, float))]
        return (round(sum(v) / len(v)) if d == 0 else round(sum(v) / len(v), d)) if v else None

    periods = []
    for k, g in sorted(groups.items()):
        foot = [a for a in g if FOOT.search((a.get("activityType") or {}).get("typeKey") or "")]
        easy = [a for a in foot if z2 and a.get("averageHR") and z2[0] <= a["averageHR"] < z2[1] and (sp(a) or 0) > 0]
        fs = [sp(a) for a in foot if sp(a)]
        periods.append(clean({
            ("month" if by == "month" else "week_of"): k, "sessions": len(g), "km": r1(sum(a.get("distance") or 0 for a in g) / 1000),
            "hours": r2(sum(a.get("duration") or 0 for a in g) / 3600), "training_load": round(sum(a.get("activityTrainingLoad") or 0 for a in g)),
            "avg_aerobic_te": avg([a.get("aerobicTrainingEffect") for a in g]), "avg_pace_min_km": pace(sum(fs) / len(fs)) if fs else None,
            "avg_hr_bpm": avg([a.get("averageHR") for a in g], 0),
            "efficiency_factor": avg([sp(a) * 60 / a["averageHR"] for a in foot if a.get("averageHR") and sp(a)], 2),
            "easy_runs_in_zone2": len(easy), "pace_at_zone2_min_km": pace(sum(sp(a) for a in easy) / len(easy)) if easy else None,
            "cadence_spm": avg([a.get("averageRunningCadenceInStepsPerMinute") for a in foot], 0), "stride_cm": avg([a.get("avgStrideLength") for a in foot]),
            "ground_contact_ms": avg([a.get("avgGroundContactTime") for a in foot], 0), "vertical_oscillation_cm": avg([a.get("avgVerticalOscillation") for a in foot]),
            "vertical_ratio_pct": avg([a.get("avgVerticalRatio") for a in foot]), "avg_power_w": avg([a.get("avgPower") for a in g], 0),
            "longest_km": r2(max((a.get("distance") or 0) for a in g) / 1000),
        }))
    return {"type": kind, "from": frm, "to": to, "by": "month" if by == "month" else "week (Monday start)", "zone2_bpm": z2, "periods": periods,
            "note": "Efficiency factor = metres per minute per heartbeat; rising = fitter. Pace at zone 2 compares runs done at an easy HR."}


def profile(weeks, to):
    frm = (day(to) - dt.timedelta(days=7 * weeks)).isoformat()
    zones = [clean({"sport": low(z.get("sport")), "method": low(z.get("trainingMethod")), "max_hr_bpm": z.get("maxHeartRateUsed"), "lthr_bpm": z.get("lactateThresholdHeartRateUsed"),
                    "resting_hr_bpm": z.get("restingHeartRateUsed"), "zone_floors_bpm": [z.get(f"zone{i}Floor") for i in range(1, 6)]}) for z in hr_zones_raw()]
    f = try_get(f"/fitnessage-service/fitnessage/v2/{to}")
    f = (f[0] if f else {}) if isinstance(f, list) else (f if isinstance(f, dict) and "__error" not in f else {})
    fa = clean({"fitness_age": r1(f.get("fitnessAge")), "achievable": r1(f.get("achievableFitnessAge")), "age": f.get("chronologicalAge"),
                "drivers": {k: (v or {}).get("value") if isinstance(v, dict) else v for k, v in (f.get("components") or {}).items()} or None})
    weeks_hr = {}
    for d in get_daily(frm, to):
        if d.get("resting_hr_bpm") is not None and d.get("date"):
            weeks_hr.setdefault(week_start(d["date"]), []).append(d["resting_hr_bpm"])
    st = settings()
    goal = None
    w = try_get(f"/goal-service/goal/user/effective/weightgoal/{(day(to) - dt.timedelta(days=365)).isoformat()}/{to}")
    x = w[-1] if isinstance(w, list) and w else (w if isinstance(w, dict) and "__error" not in w else None)
    if x:
        gr = x.get("weightGoal") or x.get("goalValue")
        goal = clean({"low_kg": g_kg(x.get("lowWeightGoalInGrams")), "high_kg": g_kg(x.get("highWeightGoalInGrams")), "target_kg": g_kg(gr) if isinstance(gr, (int, float)) and gr > 1000 else None}) or None
    acts = raw_activities(frm, to)
    seen, spikes = max_hr_seen(acts)
    fa_hist, fa_note = fitness_age_history(min(12, max(2, weeks // 4)), to)
    return {"hr_zones_now": zones, "fitness_age_now": fa or None, "fitness_age_by_month": fa_hist, "fitness_age_history_note": fa_note,
            "max_hr_seen_by_month": seen, "max_hr_spikes_ignored_bpm": spikes or None,
            "max_hr_note": "Highest heart rate reached in a workout each month, not your true max HR (that's only higher if you never went all-out). Isolated sensor spikes are left out.",
            "resting_hr_by_week": [{"week_of": k, "avg_bpm": round(sum(v) / len(v)), "lowest_bpm": min(v)} for k, v in sorted(weeks_hr.items())],
            "weight_goal": goal, "settings": clean({"units": low(st.get("measurementSystem")), "time_zone": st.get("timeZone"),
                                                    "training_days": st.get("availableTrainingDays"), "long_training_days": st.get("preferredLongTrainingDays")}) or None,
            "history_note": "This skill reads Garmin live and keeps nothing. Rebuilt from Garmin's own data: resting HR by week, the highest HR seen in workouts per month, and fitness age by month (if Garmin keeps it). "
                            "Threshold HR (LTHR) history isn't available: Garmin's Personal API only gives today's value. For a saved history over time, use option 2 (your own connector).",
            "not_available": "VO2max history, Training Status, Training Readiness, FTP, Endurance and Hill Score are not in Garmin's Personal API."}


def max_hr_seen(acts):
    """Highest heart rate reached in workouts, per month. An isolated spike (wrist sensors can lock onto
    your step rate) more than 8 bpm above every other workout in the period is left out."""
    vals = sorted({a["maxHR"] for a in acts if isinstance(a.get("maxHR"), (int, float)) and 100 <= a["maxHR"] <= 230}, reverse=True)
    spikes = []
    while len(vals) >= 2 and vals[0] - vals[1] > 8:
        spikes.append(vals.pop(0))
    months = {}
    for a in acts:
        v, d = a.get("maxHR"), (a.get("startTimeLocal") or "")[:7]
        if d and isinstance(v, (int, float)) and 100 <= v <= 230 and v not in spikes and v > months.get(d, {}).get("bpm", 0):
            months[d] = {"month": d, "bpm": round(v), "id": str(a.get("activityId")), "name": a.get("activityName")}
    return [months[k] for k in sorted(months)], [round(x) for x in spikes]


def fitness_age_history(months, to):
    """Fitness age on the 1st of each past month. If Garmin gives the same answer for every date, it
    doesn't keep history for this account, and nothing is shown (better than a flat fake line)."""
    out, d = [], day(to).replace(day=1)
    for _ in range(months):
        f = try_get(f"/fitnessage-service/fitnessage/v2/{d.isoformat()}")
        f = (f[0] if f else {}) if isinstance(f, list) else (f if isinstance(f, dict) and "__error" not in f else {})
        if f.get("fitnessAge") is not None:
            out.append({"date": d.isoformat(), "fitness_age": r1(f.get("fitnessAge")), "achievable": r1(f.get("achievableFitnessAge"))})
        d = (d - dt.timedelta(days=1)).replace(day=1)
        time.sleep(0.2)
    out.reverse()
    if len(out) >= 2 and len({x["fitness_age"] for x in out}) == 1:
        return None, "Garmin returned the same fitness age for every past date, so it doesn't seem to keep a history for your account."
    return out or None, None if out else "Garmin gave no fitness age for past dates."


def scan(kind, frm, to, n):
    """Best efforts (400 m to marathon) found inside your most recent runs, by analysing each run's file.
    Slow on purpose: a short pause between downloads, and it stops early (keeping what it found) if Garmin
    asks it to slow down."""
    cycling = bool(re.search("cycl|bik|ride", kind or ""))
    acts = [a for a in raw_activities(frm, to) if (re.search("cycl|bik|ride", type_of(a)) if cycling else FOOT.search(type_of(a)))]
    acts = sorted(acts, key=lambda a: a.get("startTimeLocal") or "", reverse=True)[:n]
    best, done, skipped, stopped = {}, 0, [], None
    start = time.time()
    for a in acts:
        if time.time() - start > 150:
            stopped = "Stopped after about 2.5 minutes to keep the chat responsive: ask again with --to set before the oldest run scanned to continue."
            break
        aid = str(a.get("activityId"))
        try:
            x = activity_analysis(aid)
        except GarminError as e:
            if len(e.args) > 1 and e.args[1] == 429:
                stopped = "Garmin asked to slow down (too many requests), so the scan stopped early. Try again in a few minutes."
                break
            skipped.append(aid)
            continue
        done += 1
        for name, e in (x.get("best_efforts") or {}).items():
            if name not in best or e["time_s"] < best[name]["time_s"]:
                best[name] = {**e, "date": (a.get("startTimeLocal") or "")[:10], "id": aid, "name": a.get("activityName")}
        time.sleep(0.4)
    order = [n for _, n in (RIDE_DISTANCES if cycling else RUN_DISTANCES)]
    return {"type": "cycling" if cycling else "running", "activities_scanned": done, "of": len(acts),
            "newest": (acts[0].get("startTimeLocal") or "")[:10] if acts else None, "oldest_scanned": (acts[max(0, done - 1)].get("startTimeLocal") or "")[:10] if done else None,
            "best_efforts": {k: best[k] for k in order if k in best}, "skipped_no_file": skipped or None, "stopped_early": stopped,
            "note": "Fastest stretch of each distance inside these runs (moving time, pauses left out), from the watch files. Only the runs scanned count: "
                    "older bests are missed unless you scan further back. Garmin's own records (1 km to marathon, all activities) are in the records command."}


def strength(aid, frm, to):
    if aid:
        a = activity_analysis(aid)
        return {"id": a["id"], "name": a.get("name"), "start": a.get("start_local"), "sets": a.get("sets") or [], "per_exercise": summarize_sets(a.get("summarized_exercise_sets")),
                "note": "Weights are what you entered on the watch; reps are counted by the watch unless you edited them." if a.get("sets") else "No sets in this activity file."}
    lst = [a for a in raw_activities(frm, to) if (isinstance(a.get("summarizedExerciseSets"), list) and a["summarizedExerciseSets"]) or "strength" in ((a.get("activityType") or {}).get("typeKey") or "")]
    totals, workouts = {}, []
    for a in lst:
        per = summarize_sets(a.get("summarizedExerciseSets")) or []
        for e in per:
            t = totals.setdefault(e["exercise"], {"exercise": e["exercise"], "workouts": 0, "sets": 0, "reps": 0, "volume_kg": 0, "max_weight_kg": None})
            t["workouts"] += 1
            t["sets"] += e["sets"] or 0
            t["reps"] += e["reps"] or 0
            t["volume_kg"] = round(t["volume_kg"] + (e["volume_kg"] or 0))
            t["max_weight_kg"] = max(t["max_weight_kg"] or 0, e["max_weight_kg"] or 0) or None
        workouts.append(clean({"id": str(a.get("activityId")), "date": (a.get("startTimeLocal") or "")[:10], "name": a.get("activityName"), "min": minutes(a.get("duration")),
                               "total_sets": a.get("totalSets"), "active_sets": a.get("activeSets"), "total_reps": a.get("totalReps"), "exercises": per}))
    return {"from": frm, "to": to, "workouts": workouts, "per_exercise_totals": sorted(totals.values(), key=lambda t: -t["sets"]),
            "note": "Use strength <id> for every set of one workout (from its file)."}


def run(args):
    c = args.command
    if c == "check":
        token(force=True)
        return {"ok": True, "message": "Garmin key works.", "host": HOST}
    if c == "activities":
        frm, to = date_range(args, 7)
        acts = get_activities(frm, to)
        if args.type:
            acts = [a for a in acts if args.type.lower() in (a.get("type") or "")]
        return {"from": frm, "to": to, "count": len(acts), "total_km": round(sum(a.get("km") or 0 for a in acts), 1),
                "total_min": round(sum(a.get("min") or 0 for a in acts)), "activities": acts}
    if c == "activity":
        aid = re.sub(r"\D", "", args.id or "")
        if not aid:
            raise GarminError("Give an activity id (from the activities command).")
        d = get(f"/activity-service/activity/{aid}") or {}
        try:
            w = get(f"/activity-service/activity/{aid}/workouts")
        except GarminError:
            w = []
        s = d.get("summaryDTO") or {}
        out = clean({"id": aid, "name": d.get("activityName"), "type": (d.get("activityTypeDTO") or {}).get("typeKey"),
                     "start": local(s.get("startTimeLocal")), **activity_detail(d, w)})
        if out.get("split_summaries"):
            out["split_summaries_note"] = "Totals per split type (e.g. all active intervals together), NOT per-km splits or laps: use the splits command for those."
        return out
    if c == "daily":
        frm, to = date_range(args, 7)
        return {"from": frm, "to": to, "days": get_daily(frm, to)}
    if c == "sleep":
        frm, to = date_range(args, 7)
        n = get_sleep(frm, to)
        return {"from": frm, "to": to, "avg_total_min": mean(x.get("total_min") for x in n), "avg_score": mean(x.get("score") for x in n), "nights": n}
    if c == "hrv":
        frm, to = date_range(args, 7)
        n = get_hrv(frm, to)
        return {"from": frm, "to": to, "avg_ms": mean(x.get("last_night_avg_ms") for x in n), "nights": n}
    if c == "body-battery":
        frm, to = date_range(args, 7)
        return {"from": frm, "to": to, "days": get_bb(frm, to)}
    if c == "weight":
        frm, to = date_range(args, 90)
        return {"from": frm, "to": to, "entries": get_weight(frm, to)}
    if c == "hr-zones":
        z = get("/biometric-service/heartRateZones/v2") or []
        return {"zones": [clean({"sport": low(x.get("sport")) or "default", "method": low(x.get("trainingMethod")), "max_hr_bpm": x.get("maxHeartRateUsed"),
                                 "resting_hr_bpm": x.get("restingHeartRateUsed"), "lthr_bpm": x.get("lactateThresholdHeartRateUsed"),
                                 "zone_floors_bpm": [x.get(f"zone{i}Floor") for i in range(1, 6)]}) for x in z]}
    if c == "fitness-age":
        f = get(f"/fitnessage-service/fitnessage/v2/{args.to or dt.date.today().isoformat()}")
        f = (f[0] if f else {}) if isinstance(f, list) else (f or {})
        return clean({"fitness_age": r1(f.get("fitnessAge")), "achievable": r1(f.get("achievableFitnessAge")), "age": f.get("chronologicalAge"), "previous": r1(f.get("previousFitnessAge"))})
    if c in ("splits", "analyze", "streams"):
        a = activity_analysis(args.id)
        head = {"id": a["id"], "name": a.get("name"), "type": a.get("type"), "start": a.get("start_local")}
        if c == "splits":
            return {**head, "splits_km": a["splits_km"], "laps": a["laps"], "legs": a["legs"],
                    "note": "splits_km are computed from the recording (moving time, pauses left out); laps are what the watch recorded."}
        if c == "analyze":
            return {**head, "analysis": a["analysis"], "best_efforts": a["best_efforts"], "best_power_w": a["best_power_w"], "pauses": a["pauses"],
                    "standing_still": a["standing_still"], "legs": a["legs"], "strength_sets": len([x for x in a["sets"] or [] if x["type"] == "active"]) if a["sets"] else None,
                    "garmin_summary": a.get("garmin_summary")}
        want = [CHANNELS[x.strip()] for x in (args.channels or "").split(",") if x.strip() in CHANNELS] or None
        foot = bool(FOOT.search(a.get("type") or "") or FOOT.search(a.get("sport") or ""))
        ds = downsample(a["series"], max(10, min(600, args.points or 120)), want, foot)
        recorded = [n for n, k in CHANNELS.items() if k in a["series"] and n not in ("speed", "heart_rate")]
        return {**head, "channels_recorded": recorded, **ds}
    if c == "strength":
        to = args.to or dt.date.today().isoformat()
        frm = args.frm or (day(to) - dt.timedelta(days=27)).isoformat()
        return strength(args.id, frm, to)
    if c == "day":
        return day_detail(args.date or args.to or dt.date.today().isoformat(), max(2, min(60, args.every or 15)))
    if c == "records":
        frm, to = date_range(args, 365, max_days=3660)
        return records(args.type, frm, to)
    if c == "trends":
        frm, to = date_range(args, 182, max_days=3660)
        return trends(args.type, frm, to, args.by)
    if c == "scan":
        frm, to = date_range(args, 365, max_days=3660)
        return scan(args.type, frm, to, max(1, min(60, args.runs or 30)))
    if c == "profile":
        return profile(max(4, min(104, args.weeks or 26)), args.to or dt.date.today().isoformat())
    if c == "overview":
        to = args.to or dt.date.today().isoformat()
        frm = (day(to) - dt.timedelta(days=6)).isoformat()
        acts, nights, h, days = get_activities(frm, to), get_sleep(frm, to), get_hrv(frm, to), get_daily(frm, to)
        return {
            "period": f"{frm} to {to}",
            "training": {"sessions": len(acts), "km": round(sum(a.get("km") or 0 for a in acts), 1), "minutes": round(sum(a.get("min") or 0 for a in acts)),
                         "load": sum(a.get("training_load") or 0 for a in acts), "latest": acts[-3:]},
            "sleep": {"avg_total_min": mean(x.get("total_min") for x in nights), "avg_score": mean(x.get("score") for x in nights), "last_night": nights[-1] if nights else None},
            "hrv": {"avg_ms": mean(x.get("last_night_avg_ms") for x in h), "last_night": h[-1] if h else None},
            "resting_hr_bpm_by_day": {d["date"]: d.get("resting_hr_bpm") for d in days if d.get("date")},
            "body_battery_today": next((clean({"high": d.get("body_battery_high"), "low": d.get("body_battery_low"), "end": d.get("body_battery_end")}) for d in reversed(days)), None),
        }
    raise GarminError(f"Unknown command {c}.")


def main():
    p = argparse.ArgumentParser(description="Read your own Garmin Connect data (read-only).")
    p.add_argument("command", choices=["check", "overview", "activities", "activity", "daily", "sleep", "hrv", "body-battery", "weight", "hr-zones", "fitness-age",
                                       "splits", "analyze", "streams", "strength", "day", "records", "trends", "profile", "scan"])
    p.add_argument("id", nargs="?", help="activity id (activity, splits, analyze, streams, strength)")
    p.add_argument("--from", dest="frm", help="YYYY-MM-DD")
    p.add_argument("--to", help="YYYY-MM-DD (default today)")
    p.add_argument("--type", help='activities, records, trends: e.g. "running", "cycling" (trends: also "all")')
    p.add_argument("--date", help="day: YYYY-MM-DD (default today)")
    p.add_argument("--every", type=int, help="day: minutes per curve block, 2-60 (default 15)")
    p.add_argument("--points", type=int, help="streams: rows wanted, 10-600 (default 120)")
    p.add_argument("--channels", help="streams: e.g. hr,pace,cadence,power,altitude,grade_adjusted_pace (default: all recorded)")
    p.add_argument("--by", choices=["week", "month"], help="trends: group by week (default) or month")
    p.add_argument("--runs", type=int, help="scan: how many recent runs (or rides) to analyse, 1-60 (default 30)")
    p.add_argument("--weeks", type=int, help="profile: weeks of resting-HR history, 4-104 (default 26)")
    args = p.parse_args()
    if args.command in ("splits", "analyze", "streams") and not args.id:
        print(json.dumps({"error": f"Give an activity id: garmin.py {args.command} <id> (ids come from the activities command)."}))
        sys.exit(1)
    for v in (args.frm, args.to, args.date):
        if v and not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            print(json.dumps({"error": f"Dates must look like 2026-10-27 (got {v})."}))
            sys.exit(1)
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=1))
    except GarminError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
