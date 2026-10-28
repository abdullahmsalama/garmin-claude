"""Tests for the skill: FIT decoding and workout analysis on synthetic files, then every command against a
fake Garmin server on localhost (no network, no real data). Run: python3 -m unittest discover skill/test
"""
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "my-garmin-data", "scripts")
sys.path.insert(0, SCRIPTS)
from analysis import analyze, downsample  # noqa: E402
from fit import decode_fit, fit_from_download  # noqa: E402

FIT_EPOCH = 631065600
U8, U16, U32, ENUM = 0x02, 0x84, 0x86, 0x00
START = 1792468800000  # 2026-10-20 04:00 UTC


def ts(ms):
    return round(ms / 1000) - FIT_EPOCH


def build_fit(msgs):
    """msgs: [(global, [(num, size, base), ...], [values])] -> FIT bytes (little-endian, normal headers)."""
    parts, defs = [], {}
    for g, fields, values in msgs:
        key = (g, tuple(fields))
        if key not in defs:
            local = len(defs) % 16
            defs[key] = local
            parts.append(bytes([0x40 | local, 0, 0, g & 0xFF, g >> 8, len(fields)]) + b"".join(bytes(f) for f in fields))
        body = bytearray([defs[key]])
        for (num, size, base), v in zip(fields, values):
            if isinstance(v, list):
                body += b"".join(struct.pack("<H", x) for x in v)
                continue
            if v is None:
                v = {1: 0xFF, 2: 0xFFFF, 4: 0xFFFFFFFF}[size]
            body += struct.pack({1: "<B", 2: "<H", 4: "<I"}[size], v)
        parts.append(bytes(body))
    data = b"".join(parts)
    hdr = struct.pack("<BBHI4sH", 14, 0x20, 2100, len(data), b".FIT", 0)
    return hdr + data + b"\0\0"


REC = [(253, 4, U32), (3, 1, U8), (4, 1, U8), (5, 4, U32), (73, 4, U32), (78, 4, U32), (39, 2, U16), (41, 2, U16), (83, 2, U16), (85, 2, U16), (84, 2, U16), (7, 2, U16)]
EV = [(253, 4, U32), (0, 1, ENUM), (1, 1, ENUM)]


def run_fit(km=5, pace=300, hr0=140, drift=10, pause_at=3, start=START):
    """A run: `km` at `pace` s/km, HR rising `drift` bpm, one 60 s pause at `pause_at` km, saved as one lap."""
    msgs, speed, total = [], 1000 / pace, km * pace
    msgs.append((21, EV, [ts(start), 0, 0]))
    t, d, paused = start, 0.0, False
    for s in range(total + 1):
        if not paused and pause_at is not None and d >= pause_at * 1000:
            paused = True
            msgs.append((21, EV, [ts(t), 0, 1]))
            t += 60000
            msgs.append((21, EV, [ts(t), 0, 0]))
        hr = round(hr0 + drift * s / total)
        msgs.append((20, REC, [ts(t), hr, 85, round(d * 100), round(speed * 1000), round((100 + 500) * 5), 860, 2450, 780, 11500, 4980, 250]))
        t += 1000
        d += speed
    lap = [(253, 4, U32), (2, 4, U32), (7, 4, U32), (8, 4, U32), (9, 4, U32), (15, 1, U8), (110, 4, U32)]
    msgs.append((19, lap, [ts(t), ts(start), t - start, total * 1000, round(d * 100), hr0 + drift // 2, round(speed * 1000)]))
    ses = [(253, 4, U32), (2, 4, U32), (5, 1, ENUM), (7, 4, U32), (8, 4, U32), (9, 4, U32), (16, 1, U8), (124, 4, U32)]
    msgs.append((18, ses, [ts(t), ts(start), 1, t - start, total * 1000, round(d * 100), hr0 + drift // 2, round(speed * 1000)]))
    return build_fit(msgs)


def strength_fit(start=START):
    msgs = []
    fields = [(254, 4, U32), (0, 4, U32), (3, 2, U16), (4, 2, U16), (5, 1, U8), (6, 4, U32), (7, 4, U16), (8, 4, U16)]
    for i in range(6):
        active = i % 2 == 0
        msgs.append((225, fields, [ts(start + i * 90000), 45000 if active else 60000, 10 - i if active else None, 60 * 16 + i * 8 if active else None,
                                   1 if active else 0, ts(start + i * 90000), [0, 0xFFFF] if active else [0xFFFF, 0xFFFF], [5, 0xFFFF] if active else [0xFFFF, 0xFFFF]]))
    for s in range(0, 540, 5):
        msgs.append((20, [(253, 4, U32), (3, 1, U8)], [ts(start + s * 1000), 110 + (25 if s % 90 < 45 else 0)]))
    msgs.append((18, [(253, 4, U32), (2, 4, U32), (5, 1, ENUM), (7, 4, U32), (8, 4, U32)], [ts(start + 540000), ts(start), 10, 540000, 540000]))
    return build_fit(msgs)


def zipped(fit, name="123_ACTIVITY.fit"):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, fit)
    return b.getvalue()


class FitAndAnalysis(unittest.TestCase):
    def test_run_splits_pause_and_analysis(self):
        fit = decode_fit(fit_from_download(zipped(run_fit())))
        self.assertEqual(len(fit["laps"]), 1, "saved as one lap")
        self.assertEqual(fit["sessions"][0]["sport"], 1)
        a = analyze(fit, zones=[100, 120, 140, 150, 160])
        full = [x for x in a["splits_km"] if not x["partial"]]
        self.assertEqual(len(full), 5, "5 per-km splits from a one-lap run")
        for x in full:
            self.assertEqual(x["pace_min_km"], "5:00")
            self.assertEqual(x["avg_cadence"], 170)  # 85 rpm x 2
        self.assertEqual(len(a["pauses"]), 1)
        self.assertEqual(a["pauses"][0]["duration_s"], 60)
        self.assertAlmostEqual(a["pauses"][0]["at_km"], 3.0, delta=0.01)
        an = a["analysis"]
        self.assertEqual(an["moving_time"], "25:00")
        self.assertEqual(an["elapsed_time"], "26:00")
        self.assertEqual(an["avg_pace_min_km"], "5:00")
        self.assertGreater(an["hr_drift_bpm"], 3, "HR rises through the run")
        self.assertGreater(an["decoupling_pct"], 0)
        self.assertEqual(a["best_efforts"]["5k"]["time"], "25:00")
        self.assertEqual(a["best_efforts"]["1k"]["pace_min_km"], "5:00")
        self.assertAlmostEqual(sum(v for k, v in an["hr_zones"].items() if k.endswith("_min")), 25, delta=0.2)
        self.assertEqual(an["avg_ground_contact_ms"], 245)
        ds = downsample(a["series"], 50, None, True)
        self.assertLessEqual(len(ds["rows"]), 60)
        self.assertIn("hr_bpm", ds["columns"])
        self.assertEqual(ds["rows"][5][ds["columns"].index("pace_min_km")], "5:00")

    def test_strength_sets(self):
        a = analyze(decode_fit(strength_fit()))
        sets = a["sets"]
        self.assertEqual(len(sets), 6)
        self.assertEqual([x["type"] for x in sets[:2]], ["active", "rest"])
        self.assertEqual(sets[0]["exercise"], "bench_press")
        self.assertEqual(sets[0]["reps"], 10)
        self.assertEqual(sets[0]["weight_kg"], 60)
        self.assertEqual(a["splits_km"], [])

    def test_bad_files(self):
        from fit import FitError
        with self.assertRaises(FitError):
            fit_from_download(b"hello world, not a file")
        with self.assertRaises(FitError):
            fit_from_download(zipped(b"x", name="notes.txt"))


# ---------- every command against a fake Garmin ----------
ACT = {"activityId": 111, "activityName": "Morning Run", "startTimeLocal": "2026-10-20 07:00:00", "activityType": {"typeKey": "running"}, "distance": 5000,
       "duration": 1500, "movingDuration": 1500, "averageHR": 145, "averageSpeed": 3.333, "activityTrainingLoad": 80, "aerobicTrainingEffect": 3.1,
       "averageRunningCadenceInStepsPerMinute": 170, "fastestSplit_1000": 290, "fastestSplit_5000": 1500}
GYM = {"activityId": 222, "activityName": "Strength", "startTimeLocal": "2026-10-21 18:00:00", "activityType": {"typeKey": "strength_training"}, "duration": 540,
       "summarizedExerciseSets": [{"category": "BENCH_PRESS", "sets": 3, "reps": 24, "volume": 1500000, "maxWeight": 62000}]}
ZONES = [{"sport": "DEFAULT", "trainingMethod": "HR_MAX", "maxHeartRateUsed": 190, "lactateThresholdHeartRateUsed": 168, "restingHeartRateUsed": 50,
          "zone1Floor": 100, "zone2Floor": 120, "zone3Floor": 140, "zone4Floor": 150, "zone5Floor": 160}]


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, ctype="application/json", status=200):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.send({"access_token": "t0k", "expires_in": 86400})

    def do_GET(self):
        u = urlparse(self.path)
        q, p = parse_qs(u.query), u.path
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            return self.send({"error": "no token"}, status=401)
        if p.startswith("/activitylist-service"):
            day0 = q["startDate"][0]
            acts = [a for a in (ACT, GYM) if q["startDate"][0] <= a["startTimeLocal"][:10] <= q["endDate"][0]]
            return self.send(acts if int(q.get("start", ["0"])[0]) == 0 and day0 else [])
        if p == "/download-service/files/activity/111":
            return self.send(zipped(run_fit()), "application/zip")
        if p == "/download-service/files/activity/222":
            return self.send(zipped(strength_fit()), "application/zip")
        if p.startswith("/download-service"):
            return self.send({}, status=404)
        if p == "/activity-service/activity/111":
            return self.send({"activityName": "Morning Run", "activityTypeDTO": {"typeKey": "running"},
                              "summaryDTO": {"startTimeLocal": "2026-10-20T07:00:00.0", "distance": 5000, "movingDuration": 1500, "averageHR": 145},
                              "splitSummaries": [{"splitType": "INTERVAL_ACTIVE", "noOfSplits": 1, "distance": 5000, "duration": 1500}]})
        if p == "/activity-service/activity/222":
            return self.send({"activityName": "Strength", "activityTypeDTO": {"typeKey": "strength_training"}, "summaryDTO": {"startTimeLocal": "2026-10-21T18:00:00.0"},
                              "summarizedExerciseSets": GYM["summarizedExerciseSets"]})
        if p.endswith("/details"):
            return self.send({"metricDescriptors": [{"key": "directTimestamp"}, {"key": "directGradeAdjustedSpeed"}],
                              "activityDetailMetrics": [{"metrics": [START + i * 10000, 3.4]} for i in range(160)]})
        if p.endswith("/workouts"):
            return self.send([])
        if p.startswith("/biometric-service/heartRateZones"):
            return self.send(ZONES)
        if p == "/userprofile-service/userprofile/settings":
            return self.send({"timeZone": "Europe/Berlin", "measurementSystem": "METRIC"})
        if p.startswith("/usersummary-service/v2/dailysummaries"):
            return self.send({"data": [{"calendarDate": "2026-10-20", "heartRate": {"restingValue": 50}}, {"calendarDate": "2026-10-27", "heartRate": {"restingValue": 48}}]})
        if p == "/wellness-service/wellness/dailyHeartRate":
            return self.send({"restingHeartRate": 50, "maxHeartRate": 170, "heartRateValues": [[START + i * 120000, 60 + i % 30] for i in range(720)]})
        if p.startswith("/hrv-service/hrv/2"):
            return self.send({"hrvSummary": {"lastNightAvg": 62, "status": "BALANCED"}, "sleepStartTimestampGMT": "2026-10-19T21:30:00.0",
                              "hrvReadings": [{"readingTimeGMT": "2026-10-19T22:00:00.0", "hrvValue": 60}]})
        if p == "/sleep-service/sleep/dailySleep":
            return self.send({"sleepTimeSeconds": 27000, "deepSleepSeconds": 5400, "sleepStartTimestampGMT": "2026-10-19T21:30:00.0",
                              "sleepScores": {"overall": {"value": 80, "qualifierKey": "GOOD"}, "duration": {"value": 85}}})
        if p == "/usersummary-service/usersummary/daily":
            return self.send({"totalSteps": 9000, "restingHeartRate": 50, "averageStressLevel": 30, "restStressDuration": 3600000})
        if p.startswith("/wellness-service/wellness/daily/spo2"):
            return self.send({"averageSpO2": 96})
        if p == "/wellness-service/wellness/bodyBattery/reports/daily":
            return self.send([{"charged": 50, "drained": 40, "bodyBatteryValueDescriptorDTOList": [{"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
                                                                                            {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"}],
                               "bodyBatteryValuesArray": [[START + i * 900000, 30 + i % 50] for i in range(96)]}])
        if p.startswith("/fitnessage-service"):
            return self.send({"fitnessAge": 31.4, "chronologicalAge": 35, "components": {"rhr": {"value": 50}}})
        if p.startswith("/goal-service"):
            return self.send([])
        return self.send({"error": "unknown"}, status=404)


class Commands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp()
        cls.env = {**os.environ, "GARMIN_BASE": f"http://127.0.0.1:{cls.srv.server_port}", "GARMIN_API_KEY": "test-key", "TMPDIR": cls.tmp, "TEMP": cls.tmp}

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def cmd(self, *args):
        p = subprocess.run([sys.executable, os.path.join(SCRIPTS, "garmin.py"), *args], env=self.env, capture_output=True, text=True, timeout=60)
        out = json.loads(p.stdout)
        self.assertNotIn("error", out, out)
        return out

    def test_splits_analyze_streams(self):
        s = self.cmd("splits", "111")
        self.assertEqual(len([x for x in s["splits_km"] if not x["partial"]]), 5)
        self.assertEqual(s["splits_km"][0]["grade_adjusted_pace_min_km"], "4:54")  # from Garmin's chart data
        self.assertEqual(len(s["laps"]), 1)
        a = self.cmd("analyze", "111")
        self.assertEqual(a["analysis"]["moving_time"], "25:00")
        self.assertEqual(len(a["pauses"]), 1)
        self.assertIn("z3_min", a["analysis"]["hr_zones"])
        st = self.cmd("streams", "111", "--points", "30", "--channels", "hr,pace")
        self.assertEqual(st["columns"], ["min", "km", "pace_min_km", "hr_bpm"])
        self.assertLessEqual(len(st["rows"]), 40)

    def test_activity_names_split_summaries(self):
        a = self.cmd("activity", "111")
        self.assertIn("split_summaries", a)
        self.assertNotIn("splits", a)
        self.assertIn("splits command", a["split_summaries_note"])

    def test_strength(self):
        one = self.cmd("strength", "222")
        self.assertEqual(len(one["sets"]), 6)
        self.assertEqual(one["per_exercise"][0]["max_weight_kg"], 62)
        rng = self.cmd("strength", "--from", "2026-10-01", "--to", "2026-10-28")
        self.assertEqual(rng["per_exercise_totals"][0]["sets"], 3)

    def test_day_uses_the_garmin_time_zone(self):
        d = self.cmd("day", "--date", "2026-10-20")
        if sys.version_info >= (3, 9):  # zoneinfo; older Pythons fall back to UTC
            self.assertEqual(d["time_zone"], "Europe/Berlin")
            self.assertEqual(d["hrv_overnight"]["readings"][0][0], "00:00")  # 22:00 UTC = midnight in Berlin (summer time)
            self.assertEqual(d["sleep"]["start"], "2026-10-19 23:30")
        self.assertEqual(d["body_battery"]["curve_columns"], ["time", "low", "avg", "high"])
        self.assertEqual(d["workouts"][0]["id"], "111")

    def test_records_trends_profile(self):
        r = self.cmd("records", "--from", "2026-01-01", "--to", "2026-10-28")
        self.assertEqual(r["records"]["5k"]["best_in_range"]["time"], "25:00")
        self.assertIn("ESTIMATE", r["race_predictions_estimated"]["method"])
        t = self.cmd("trends", "--from", "2026-10-01", "--to", "2026-10-28")
        self.assertEqual(t["periods"][0]["week_of"], "2026-10-19")
        self.assertEqual(t["periods"][0]["km"], 5.0)
        p = self.cmd("profile", "--to", "2026-10-28", "--weeks", "8")
        self.assertEqual(p["hr_zones_now"][0]["lthr_bpm"], 168)
        self.assertEqual(p["fitness_age_now"]["fitness_age"], 31.4)
        self.assertEqual(len(p["resting_hr_by_week"]), 2)

    def test_scan_and_rebuilt_history(self):
        sc = self.cmd("scan", "--from", "2026-10-01", "--to", "2026-10-28")
        self.assertEqual(sc["activities_scanned"], 1)
        self.assertEqual(sc["best_efforts"]["5k"]["time"], "25:00")
        self.assertEqual(sc["best_efforts"]["400m"]["date"], "2026-10-20")
        self.assertIsNone(sc["stopped_early"])
        p = self.cmd("profile", "--to", "2026-10-28", "--weeks", "8")
        self.assertIsNone(p["fitness_age_by_month"])  # the fake gives the same value for every date: no fake history
        self.assertIn("same fitness age", p["fitness_age_history_note"])

    def test_max_hr_seen_ignores_spikes(self):
        sys.path.insert(0, SCRIPTS)
        import garmin
        acts = [{"maxHR": v, "startTimeLocal": d, "activityId": i} for i, (v, d) in enumerate([(184, "2026-08-02"), (181, "2026-08-20"), (186, "2026-09-05"), (207, "2026-09-12"), (179, "2026-10-01")])]
        seen, spikes = garmin.max_hr_seen(acts)
        self.assertEqual([x["bpm"] for x in seen], [184, 186, 179])
        self.assertEqual(spikes, [207])

    def test_missing_id(self):
        p = subprocess.run([sys.executable, os.path.join(SCRIPTS, "garmin.py"), "splits"], env=self.env, capture_output=True, text=True)
        self.assertIn("activity id", json.loads(p.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
