---
name: my-garmin-data
description: Reads the user's own Garmin Connect data (runs and other workouts with per-km splits, HR drift and other analysis inside each workout, strength sets, sleep, HRV, resting heart rate, stress, Body Battery, weight, heart-rate zones, fitness age, records and trends) through Garmin's official read-only Personal API. Use whenever the user asks about their training, recovery, readiness, sleep, fitness or health trends, or wants advice or a plan based on their Garmin data.
---

# My Garmin data

You can read the user's own Garmin Connect data with `scripts/garmin.py` (read-only, Python standard library only; `fit.py` and `analysis.py` next to it decode and analyse workout files).

## How to get data
Run the script with Python and read the JSON it prints. Always use the path of this skill folder, e.g.:

```bash
python3 /mnt/skills/user/my-garmin-data/scripts/garmin.py overview
```

| Command | What it returns | Default range |
|---|---|---|
| `overview` | Last 7 days at a glance: training, sleep, HRV, resting HR, Body Battery. **Start here for "how am I doing / am I recovered" questions.** | 7 days |
| `activities [--type running]` | Workouts: km, min, pace (min/km), HR, cadence, climb, training load, training effect, VO2 max, HR-zone minutes, `id` | 7 days |
| `activity <id>` | One workout's summary: recovery HR, grade-adjusted pace, RPE, stamina, planned workout steps. Its `split_summaries` are Garmin's **totals per split type** (e.g. all active intervals together), **not** per-km splits | – |
| `daily` | Per day: steps, calories, resting/min/max HR, intensity minutes, stress, Body Battery, respiration, SpO2 | 7 days |
| `sleep` | Per night: total, deep, light, REM, awake minutes, score, bed/wake time | 7 days |
| `hrv` | Per night: average and 5-min high HRV (ms), 7-day average, status, baseline range | 7 days |
| `body-battery` | Per day: charged, drained, high, low, what drained or charged it | 7 days |
| `weight` | Weigh-ins: kg, BMI, body fat, muscle, water | 90 days |
| `hr-zones` | Heart-rate zone floors (bpm), max and resting HR used | – |
| `fitness-age` | Garmin fitness age vs real age | – |

### Inside one workout (`<id>` from `activities`)
These download the workout's original file from Garmin and decode it here, so they work even if the run was saved as one lap. The first call for a workout takes a few seconds; later calls in the same chat reuse it.

| Command | What it returns |
|---|---|
| `splits <id>` | **Per-km splits** (time, pace, grade-adjusted pace, HR avg/max, cadence, power, climb/descent, running dynamics), the laps the watch recorded, and multisport legs. **Use this for any "splits / km by km / laps" question.** |
| `analyze <id>` | Moving vs elapsed time, pauses (where, how long) and standing-still stops, HR drift and aerobic decoupling, efficiency factor (also grade-adjusted), negative split, km pace variability, time in HR zones from the recording, best efforts inside it (400 m to marathon; best power 5 s-60 min for rides), cadence consistency, running dynamics, stamina and Body Battery start/end, and Garmin's own summary to compare. |
| `streams <id> [--points 120] [--channels hr,pace]` | The workout over time, as rows: pace/speed, HR, cadence, power, altitude, running dynamics, temperature, Garmin's grade-adjusted pace, stamina, Body Battery. Channels: pace, hr, cadence, power, altitude, vertical_oscillation, ground_contact, gct_balance, vertical_ratio, stride, temperature, respiration, performance_condition, grade_adjusted_pace, stamina, stamina_potential, body_battery, vertical_speed. 10-600 rows. |
| `strength <id>` | Every set of a strength workout: exercise, reps, weight, duration, rests. Without an id: each strength workout in the range with sets/reps/volume per exercise, and totals (default 28 days). |

### One day and over time
| Command | What it returns | Default range |
|---|---|---|
| `day [--date YYYY-MM-DD] [--every 15]` | Everything about one day: all-day HR curve, overnight HRV readings, the Body Battery curve and what charged/drained it, SpO2, sleep in detail (stages, score parts, breathing, naps, need), the full daily summary, and that day's workouts. Times in the user's Garmin time zone. | today |
| `records [--type running\|cycling]` | Best times (1 km, mile, 5k, 10k, half, marathon) from Garmin's fastest splits, with date and activity id, best in range and last 90 days, plus **estimated** race times (Riegel formula, not Garmin's predictions). Add `--from` for older years. | 1 year |
| `trends [--type running] [--by week\|month]` | Per week or month: sessions, km, hours, training load, pace, HR, efficiency factor, pace at an easy HR (zone 2), cadence, stride, ground contact, vertical oscillation and ratio. `--type all`, `cycling`, `strength_training`… | 26 weeks |
| `profile [--weeks 26]` | HR zones per sport (max HR, LTHR, floors), fitness age now and what drives it, resting HR by week, **highest HR seen in workouts per month** (sensor spikes left out), **fitness age by month** (only if Garmin keeps it for this account), weight goal, units and training days. | 26 weeks |
| `scan [--runs 30] [--type running\|cycling]` | **Best efforts found inside your recent runs** (400 m, 1k, mile, 3k, 5k, 10k, 15k, half, marathon; for rides 5-100 km), by analysing each run's file. Slow: about 1-2 s per run, stops after ~2.5 min or if Garmin asks it to slow down, and says so. Up to 60 runs. | last year |

Add `--from YYYY-MM-DD --to YYYY-MM-DD` for other dates (up to one year back; `records` and `trends` up to ten). Long ranges take a few seconds because Garmin limits each request to about a month.

## How to answer
- Fetch only what the question needs, then answer in plain language with the real numbers (e.g. "you slept 6 h 40 on average, 50 min less than the week before").
- Compare with the user's own baseline (previous weeks, HRV baseline range) rather than population norms.
- For readiness questions combine sleep, HRV status, resting HR trend, Body Battery and recent training load.
- Units: distance km, pace min/km, time minutes. Convert to the user's preferred units if they ask.
- Questions about splits, laps, pacing, pauses, HR drift or "was it a clean effort" → `splits` / `analyze`, never `activity`'s split_summaries.
- Best efforts like 400 m, 3k or 15k: one workout → `analyze <id>`; "my best 3k lately" → `scan` (tell the user it takes about a minute first). `records` only has Garmin's 1k, mile, 5k, 10k, half and marathon, but covers every activity in the range. `scan` only counts the runs it scanned: say so.
- "Max HR" from `profile`: `max_hr_seen_by_month` is the highest HR reached in a workout, not a true max (that's higher if they never went all-out). Mention ignored spikes if there are any.
- Not in Garmin's Personal API, so you can't get them: Training Readiness, Training Status, VO2 max history, FTP, Endurance/Hill Score, Garmin's own race predictions. This skill keeps nothing between chats: LTHR (threshold HR) history isn't available at all (Garmin only gives today's value), and max HR and fitness age history are rebuilt from Garmin's own data as described above. For a saved history over time, point the user to option 2 of the guide (their own connector).
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
