"""Garmin activity files: unzip (Garmin sends a .zip) and decode the FIT messages we use.

No libraries. Field numbers, types and scales from the FIT SDK profile (Profile.xlsx).
Missing values (FIT "invalid") come back as None. Times are FIT seconds -> epoch ms (UTC).
"""
import io
import math
import struct
import zipfile

FIT_EPOCH = 631065600000  # 1989-12-31T00:00:00Z, in ms


class FitError(Exception):
    pass


# ---------- zip ----------
def fit_from_download(buf):
    """The bytes of the first .fit file inside a zip (or the input if it's already a FIT file)."""
    b = bytes(buf)
    if len(b) > 12 and b[8:12] == b".FIT":
        return b
    if b[:2] != b"PK":
        raise FitError("activity file is not a zip or FIT file")
    try:
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            for name in z.namelist():
                if name.lower().endswith(".fit"):
                    return z.read(name)
    except zipfile.BadZipFile as e:
        raise FitError(f"broken zip ({e})")
    raise FitError("no .fit file in the zip")


# ---------- profile (only what we use) ----------
# field number -> (name, scale, offset). Types come from the file itself.
PROFILE = {
    18: ("session", {253: ("timestamp",), 2: ("start_time",), 5: ("sport",), 6: ("sub_sport",), 7: ("total_elapsed_time", 1000), 8: ("total_timer_time", 1000),
                     9: ("total_distance", 100), 11: ("total_calories",), 14: ("avg_speed", 1000), 15: ("max_speed", 1000), 16: ("avg_heart_rate",), 17: ("max_heart_rate",),
                     18: ("avg_cadence",), 19: ("max_cadence",), 20: ("avg_power",), 21: ("max_power",), 22: ("total_ascent",), 23: ("total_descent",), 25: ("first_lap_index",),
                     26: ("num_laps",), 124: ("enhanced_avg_speed", 1000), 125: ("enhanced_max_speed", 1000)}),
    19: ("lap", {253: ("timestamp",), 254: ("message_index",), 2: ("start_time",), 7: ("total_elapsed_time", 1000), 8: ("total_timer_time", 1000), 9: ("total_distance", 100),
                 11: ("total_calories",), 13: ("avg_speed", 1000), 14: ("max_speed", 1000), 15: ("avg_heart_rate",), 16: ("max_heart_rate",), 17: ("avg_cadence",), 18: ("max_cadence",),
                 19: ("avg_power",), 20: ("max_power",), 21: ("total_ascent",), 22: ("total_descent",), 24: ("lap_trigger",), 25: ("sport",), 77: ("avg_vertical_oscillation", 10),
                 79: ("avg_stance_time", 10), 80: ("avg_fractional_cadence", 128), 110: ("enhanced_avg_speed", 1000), 111: ("enhanced_max_speed", 1000)}),
    20: ("record", {253: ("timestamp",), 2: ("altitude", 5, 500), 3: ("heart_rate",), 4: ("cadence",), 5: ("distance", 100), 6: ("speed", 1000), 7: ("power",), 13: ("temperature",),
                    39: ("vertical_oscillation", 10), 40: ("stance_time_percent", 100), 41: ("stance_time", 10), 53: ("fractional_cadence", 128), 73: ("enhanced_speed", 1000),
                    78: ("enhanced_altitude", 5, 500), 83: ("vertical_ratio", 100), 84: ("stance_time_balance", 100), 85: ("step_length", 10), 90: ("performance_condition",),
                    108: ("enhanced_respiration_rate", 100)}),
    21: ("event", {253: ("timestamp",), 0: ("event",), 1: ("event_type",)}),
    225: ("set", {254: ("timestamp",), 0: ("duration", 1000), 3: ("repetitions",), 4: ("weight", 16), 5: ("set_type",), 6: ("start_time",), 7: ("category",),
                  8: ("category_subtype",), 10: ("message_index",)}),
}
ARRAY_OK = {"set": {"category", "category_subtype"}}

# Base types: (byte size, struct code or None, invalid value)
BASE = {
    0x00: (1, "B", 0xFF), 0x01: (1, "b", 0x7F), 0x02: (1, "B", 0xFF), 0x83: (2, "h", 0x7FFF), 0x84: (2, "H", 0xFFFF), 0x85: (4, "i", 0x7FFFFFFF),
    0x86: (4, "I", 0xFFFFFFFF), 0x07: (1, "str", None), 0x88: (4, "f", None), 0x89: (8, "d", None), 0x0A: (1, "B", 0), 0x8B: (2, "H", 0), 0x8C: (4, "I", 0),
    0x0D: (1, "B", 0xFF), 0x8E: (8, None, None), 0x8F: (8, None, None), 0x90: (8, None, None),
}


def decode_fit(data):
    """Decodes a FIT file into {sessions, laps, records, events, sets}: plain dicts, scaled units, None for missing."""
    u8 = bytes(data)
    if len(u8) < 12 or u8[8:12] != b".FIT":
        raise FitError("not a FIT file")
    hs = u8[0]
    size = struct.unpack_from("<I", u8, 4)[0]
    out = {"session": [], "lap": [], "record": [], "event": [], "set": []}
    defs = {}
    p, last_ts = hs, 0
    end = min(hs + size, len(u8))
    while p < end:
        h = u8[p]
        p += 1
        ts_override = None
        if h & 0x80:  # compressed timestamp header
            d = defs.get((h >> 5) & 3)
            off = h & 0x1F
            ts_override = (last_ts & ~0x1F) + off + (0x20 if off < (last_ts & 0x1F) else 0)
            last_ts = ts_override
        elif h & 0x40:  # definition message
            little = u8[p + 1] == 0
            g = struct.unpack_from("<H" if little else ">H", u8, p + 2)[0]
            nf = u8[p + 4]
            p += 5
            prof = PROFILE.get(g)
            fields, total = [], 0
            for _ in range(nf):
                num, fsize, btype = u8[p], u8[p + 1], u8[p + 2]
                base = BASE.get(btype, (1, None, None))
                meta = prof[1].get(num) if prof else None
                if meta:
                    fields.append({"off": total, "size": fsize, "base": base, "name": meta[0],
                                   "scale": meta[1] if len(meta) > 1 else 1, "offset": meta[2] if len(meta) > 2 else 0})
                total += fsize
                p += 3
            if h & 0x20:  # developer fields: skipped
                nd = u8[p]
                p += 1
                for _ in range(nd):
                    total += u8[p + 1]
                    p += 3
            defs[h & 0x0F] = {"prof": prof, "fields": fields, "size": total, "little": little}
            continue
        else:
            d = defs.get(h & 0x0F)
        if d is None:
            raise FitError("FIT data before its definition")
        if d["prof"]:
            name = d["prof"][0]
            m = {}
            e = "<" if d["little"] else ">"
            for f in d["fields"]:
                bsize, code, invalid = f["base"]
                if code is None or code == "str":
                    continue

                def one(q, f=f, code=code, invalid=invalid):
                    v = struct.unpack_from(e + code, u8, q)[0]
                    if v == invalid or (code in "fd" and not math.isfinite(v)):
                        return None
                    return v / f["scale"] - f["offset"] if (f["scale"] != 1 or f["offset"]) else v

                n = f["size"] // bsize
                if n < 1 or p + f["off"] + bsize > len(u8):
                    continue
                if n > 1 and f["name"] in ARRAY_OK.get(name, ()):
                    arr = [v for v in (one(p + f["off"] + i * bsize) for i in range(n)) if v is not None]
                    m[f["name"]] = arr or None
                else:
                    m[f["name"]] = one(p + f["off"])
            if m.get("timestamp") is not None and name != "set":
                last_ts = m["timestamp"]
            if ts_override is not None:
                m["timestamp"] = ts_override
            for k in ("timestamp", "start_time"):
                if m.get(k) is not None:
                    m[k] = FIT_EPOCH + m[k] * 1000
            out[name].append(m)
        p += d["size"]
    return {"sessions": out["session"], "laps": out["lap"], "records": out["record"], "events": out["event"], "sets": out["set"]}


# FIT enums we turn into words.
SPORT = {0: "generic", 1: "running", 2: "cycling", 3: "transition", 4: "fitness_equipment", 5: "swimming", 6: "basketball", 10: "training", 11: "walking", 13: "e_biking",
         15: "rowing", 17: "hiking", 21: "e_biking", 22: "water_sports", 30: "inline_skating", 31: "rock_climbing", 37: "stand_up_paddleboarding", 41: "kayaking",
         43: "snowshoeing", 53: "diving", 62: "hiit", 64: "racket", 76: "water_tubing", 80: "mixed_martial_arts", 82: "motorcycling"}
EXERCISE = ["bench_press", "calf_raise", "cardio", "carry", "chop", "core", "crunch", "curl", "deadlift", "flye", "hip_raise", "hip_stability", "hip_swing",
            "hyperextension", "lateral_raise", "leg_curl", "leg_raise", "lunge", "olympic_lift", "plank", "plyo", "pull_up", "push_up", "row", "shoulder_press",
            "shoulder_stability", "shrug", "sit_up", "squat", "total_body", "triceps_extension", "warm_up", "run"]
