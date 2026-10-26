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
          body-battery, weight, hr-zones, fitness-age
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

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


def request(method, path, headers, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode("utf-8", "replace")
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
        "splits": splits, "planned_workout": steps,
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


def get_activities(frm, to):
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
    return [activity(a) for a in fetch_chunked("activities", frm, to, page)]


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
        return clean({"id": aid, "name": d.get("activityName"), "type": (d.get("activityTypeDTO") or {}).get("typeKey"),
                      "start": local(s.get("startTimeLocal")), **activity_detail(d, w)})
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
    p.add_argument("command", choices=["check", "overview", "activities", "activity", "daily", "sleep", "hrv", "body-battery", "weight", "hr-zones", "fitness-age"])
    p.add_argument("id", nargs="?", help="activity id (for the activity command)")
    p.add_argument("--from", dest="frm", help="YYYY-MM-DD")
    p.add_argument("--to", help="YYYY-MM-DD (default today)")
    p.add_argument("--type", help='activities only: filter, e.g. "running"')
    args = p.parse_args()
    for v in (args.frm, args.to):
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
