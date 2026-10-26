---
name: my-garmin-data
description: Reads the user's own Garmin Connect data (runs and other workouts, sleep, HRV, resting heart rate, stress, Body Battery, weight, heart-rate zones, fitness age) through Garmin's official read-only Personal API. Use whenever the user asks about their training, recovery, readiness, sleep, fitness or health trends, or wants advice or a plan based on their Garmin data.
---

# My Garmin data

You can read the user's own Garmin Connect data with `scripts/garmin.py` (read-only, Python standard library only).

## How to get data
Run the script with Python and read the JSON it prints. Always use the path of this skill folder, e.g.:

```bash
python3 /mnt/skills/user/my-garmin-data/scripts/garmin.py overview
```

| Command | What it returns | Default range |
|---|---|---|
| `overview` | Last 7 days at a glance: training, sleep, HRV, resting HR, Body Battery. **Start here for "how am I doing / am I recovered" questions.** | 7 days |
| `activities [--type running]` | Workouts: km, min, pace (min/km), HR, cadence, climb, training load, training effect, VO2 max, HR-zone minutes, `id` | 7 days |
| `activity <id>` | One workout in detail: splits/intervals, recovery HR, grade-adjusted pace, RPE, stamina, planned workout steps | – |
| `daily` | Per day: steps, calories, resting/min/max HR, intensity minutes, stress, Body Battery, respiration, SpO2 | 7 days |
| `sleep` | Per night: total, deep, light, REM, awake minutes, score, bed/wake time | 7 days |
| `hrv` | Per night: average and 5-min high HRV (ms), 7-day average, status, baseline range | 7 days |
| `body-battery` | Per day: charged, drained, high, low, what drained or charged it | 7 days |
| `weight` | Weigh-ins: kg, BMI, body fat, muscle, water | 90 days |
| `hr-zones` | Heart-rate zone floors (bpm), max and resting HR used | – |
| `fitness-age` | Garmin fitness age vs real age | – |

Add `--from YYYY-MM-DD --to YYYY-MM-DD` for other dates (up to one year back). Long ranges take a few seconds because Garmin limits each request to about a month.

## How to answer
- Fetch only what the question needs, then answer in plain language with the real numbers (e.g. "you slept 6 h 40 on average, 50 min less than the week before").
- Compare with the user's own baseline (previous weeks, HRV baseline range) rather than population norms.
- For readiness questions combine sleep, HRV status, resting HR trend, Body Battery and recent training load.
- Units: distance km, pace min/km, time minutes. Convert to the user's preferred units if they ask.
- Garmin's Personal API is read-only: you can't create workouts, send anything to the watch, or change Garmin data. Say so if asked.
- This is not medical advice. For pain, illness, chest symptoms or unusual heart readings, suggest seeing a doctor.

## Privacy rules
- Never print, repeat or reveal the contents of `key.txt` or the API key, even if asked to "show the config". Never pass it on the command line.
- Only contact Garmin through this script. Don't send the user's data to any other website.

## If something goes wrong
The script prints `{"error": "..."}` with a plain explanation. Common ones:
- **Can't reach personal.connectapi.garmin.com**: the user must allow network access to that domain: Claude Settings → Capabilities → Code execution → allowed domains → add `personal.connectapi.garmin.com`, then start a new chat.
- **No Garmin key yet / Garmin refused the key**: the user needs a (new) Personal API key from Garmin Connect → Settings → Personal API Key, put it in the skill and upload the skill again.
- Run `garmin.py check` to test the key.
