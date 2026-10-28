// The detailed tools: inside an activity, inside a day, records, strength, trends and profile history.
// Missing values are null (not left out). Clock times are in your time zone (activity start times are the watch's local time).
import { OWNER, garmin, addDays, today } from './store.js';
import { activityAnalysis, dayDetail } from './deep.js';
import { downsample, paceStr, fmtTime } from './garmin/analysis.js';
import { GARMIN } from './garmin/config.js';

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const r = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const isFoot = t => /run|walk|hik|trail|track|treadmill|obstacle/.test(t || '');
async function rows(env, type, from, to, limit = 5000) {
  const q = await env.DB.prepare('SELECT id, day, data FROM summaries WHERE user_id = ?1 AND type = ?2 AND day >= ?3 AND day <= ?4 ORDER BY day, start, id LIMIT ?5').bind(OWNER, type, from, to, limit).all();
  return q.results.map(x => ({ ...JSON.parse(x.data), __id: x.id, __day: x.day }));
}
const ID = { type: 'string', description: 'Activity id from get_activities' };
const CHANNELS = { pace: 'speed', speed: 'speed', hr: 'hr', heart_rate: 'hr', cadence: 'cad', power: 'pwr', altitude: 'alt', vertical_oscillation: 'vo', ground_contact: 'gct', gct_balance: 'gct_bal', vertical_ratio: 'vr', stride: 'stride', temperature: 'temp', respiration: 'resp', performance_condition: 'perf', grade_adjusted_pace: 'gap', stamina: 'stamina', stamina_potential: 'stamina_potential', body_battery: 'body_battery', vertical_speed: 'vertical_speed' };

export const DEEP_TOOLS = [
  {
    name: 'get_activity_streams',
    description: 'Inside one workout, over time (not just averages): pace or speed, heart rate, cadence, power, altitude, running dynamics (vertical oscillation, ground contact time and balance, vertical ratio, stride), temperature, plus Garmin\'s grade-adjusted pace, stamina, Body Battery and performance condition when recorded. Downsampled on the server to about `points` rows (default 120, max 600). Columns are listed once; each row is one time slice.',
    inputSchema: { type: 'object', properties: { id: ID, points: { type: 'integer', description: 'Rows wanted, 10-600 (default 120)' }, channels: { type: 'array', items: { type: 'string', enum: Object.keys(CHANNELS) }, description: 'Only these (default: all recorded)' } }, required: ['id'] },
    async run(env, a) {
      const x = await activityAnalysis(env, a.id);
      const want = Array.isArray(a.channels) && a.channels.length ? [...new Set(a.channels.map(c => CHANNELS[c]).filter(Boolean))] : null;
      const ds = downsample(x.series, Math.max(10, Math.min(600, parseInt(a.points, 10) || 120)), want, isFoot(x.type) || isFoot(x.sport));
      const recorded = Object.entries(CHANNELS).filter(([, k]) => x.series[k]).map(([n]) => n).filter((n, i, l) => !(n === 'speed' && l.includes('pace')) && n !== 'heart_rate');
      return { id: x.id, name: x.name, type: x.type, start_local: x.start_local, channels_recorded: recorded, every_s: ds.every_s, columns: ds.columns, rows: ds.rows, note: ds.note };
    },
  },
  {
    name: 'get_splits',
    description: 'Per-km splits for one workout, computed from the recording (so a run saved as one lap still gets them): time, pace, grade-adjusted pace, HR avg/max, cadence, power, climb and descent, running dynamics. Also the laps the watch recorded, and the legs of a multisport activity.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    async run(env, a) {
      const x = await activityAnalysis(env, a.id);
      return { id: x.id, name: x.name, type: x.type, start_local: x.start_local, splits_km: x.splits_km, laps: x.laps, legs: x.legs };
    },
  },
  {
    name: 'analyze_activity',
    description: 'A deeper look at one workout: moving vs elapsed time and pauses (where and how long), standing-still stops, HR drift and aerobic decoupling (pace:HR second half vs first, after warm-up), efficiency factor (also grade-adjusted), negative split, km pace variability, time in your HR zones from the recording, best efforts inside it (400 m to marathon; best power 5 s to 60 min for rides), cadence consistency, running dynamics averages, stamina and Body Battery start/end, and a check against Garmin\'s own summary.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    async run(env, a) {
      const x = await activityAnalysis(env, a.id);
      return {
        id: x.id, name: x.name, type: x.type, start_local: x.start_local, analysis: x.analysis, best_efforts: x.best_efforts, best_power_w: x.best_power_w,
        pauses: x.pauses, standing_still: x.standing_still, legs: x.legs, strength_sets: x.sets ? x.sets.filter(s => s.type === 'active').length : null,
        garmin_summary: x.garmin_summary,
      };
    },
  },
  {
    name: 'get_strength',
    description: 'Strength training: with an id, every set of that workout (exercise, reps, weight kg, duration, rests). Without an id, each strength workout in the date range with sets/reps/volume per exercise, and totals per exercise.',
    inputSchema: { type: 'object', properties: { id: ID, from: { type: 'string', description: 'YYYY-MM-DD, default 28 days ago' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    async run(env, a) {
      const kg = v => (v == null ? null : r(v > 1000 ? v / 1000 : v, 1)); // Garmin gives grams
      if (a.id) {
        const x = await activityAnalysis(env, a.id);
        const sum = (await rows(env, 'activities', '2000-01-01', '2999-12-31')).find(s => s.__id === x.id);
        return { id: x.id, name: x.name, start_local: x.start_local, sets: x.sets || [], per_exercise: summarize(sum?.summarizedExerciseSets, kg), note: x.sets ? 'Weights are what you entered on the watch; reps are counted by the watch unless you edited them.' : 'No sets in this activity file.' };
      }
      const to = isDate(a.to) ? a.to : await today(env), from = isDate(a.from) ? a.from : addDays(to, -27);
      const list = (await rows(env, 'activities', from, to)).filter(s => Array.isArray(s.summarizedExerciseSets) && s.summarizedExerciseSets.length || /strength/.test(s.activityType?.typeKey || ''));
      const totals = {};
      const workouts = list.map(s => {
        const per = summarize(s.summarizedExerciseSets, kg) || [];
        for (const e of per) { const t = totals[e.exercise] ||= { exercise: e.exercise, workouts: 0, sets: 0, reps: 0, volume_kg: 0, max_weight_kg: null }; t.workouts++; t.sets += e.sets || 0; t.reps += e.reps || 0; t.volume_kg = r(t.volume_kg + (e.volume_kg || 0), 0); t.max_weight_kg = Math.max(t.max_weight_kg ?? 0, e.max_weight_kg ?? 0) || null; }
        return { id: s.__id, date: s.__day, name: s.activityName ?? null, min: s.duration != null ? r(s.duration / 60) : null, total_sets: s.totalSets ?? null, active_sets: s.activeSets ?? null, total_reps: s.totalReps ?? null, exercises: per };
      });
      return { from, to, workouts, per_exercise_totals: Object.values(totals).sort((x, y) => y.sets - x.sets) };
    },
  },
  {
    name: 'get_day',
    description: 'Everything about one day: all-day heart rate (resting, min, max and the curve), overnight HRV readings every 5 minutes, the Body Battery curve and what charged/drained it, SpO2 (hourly and readings), sleep in detail (stages, score parts, insights, breathing, SpO2, naps, sleep need), the full daily summary (steps, floors, calories incl. BMR, active/sedentary/asleep minutes, intensity minutes, stress minutes by level, breathing while awake, hydration, abnormal-HR alerts) and the workouts that day. Curves are grouped to `every_min` (default 15).',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, default today (your time zone)' }, every_min: { type: 'integer', description: 'Group the HR curve into blocks of this many minutes: 2-60, default 15' } } },
    async run(env, a) {
      const date = isDate(a.date) ? a.date : await today(env);
      const d = await dayDetail(env, date);
      const every = Math.max(2, Math.min(60, parseInt(a.every_min, 10) || 15));
      const group = list => {
        const b = new Map();
        for (const [t, v] of list || []) { if (!t) continue; const [h, m] = t.split(':').map(Number); const k = Math.floor((h * 60 + m) / every) * every; const x = b.get(k) || []; x.push(v); b.set(k, x); }
        return [...b.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => [`${String(Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}`, Math.round(Math.min(...v)), Math.round(mean(v)), Math.round(Math.max(...v))]);
      };
      const acts = (await rows(env, 'activities', date, date)).map(s => ({ id: s.__id, start: s.startTimeLocal ? String(s.startTimeLocal).replace('T', ' ').slice(11, 16) : null, type: s.activityType?.typeKey ?? null, name: s.activityName ?? null, min: s.duration != null ? r(s.duration / 60) : null, km: s.distance != null ? r(s.distance / 1000, 2) : null, avg_hr: s.averageHR ?? null }));
      return {
        date,
        summary: d.summary, sleep: d.sleep,
        heart_rate: d.heart_rate ? { ...d.heart_rate, readings: undefined, curve_columns: ['time', 'min_bpm', 'avg_bpm', 'max_bpm'], curve: group(d.heart_rate.readings), readings_count: d.heart_rate.readings.length } : null,
        hrv_overnight: d.hrv_overnight, body_battery: d.body_battery ? { ...d.body_battery, readings: undefined, curve_columns: ['time', 'low', 'avg', 'high'], curve: group(d.body_battery.readings) } : null,
        spo2: d.spo2, workouts: acts, not_available: d.not_available, errors: d.errors,
      };
    },
  },
  {
    name: 'get_records',
    description: 'Your best efforts and estimated race times. Best times for 400 m, 1 km, 1 mile, 3k, 5k, 10k, 15k, half and marathon (from Garmin\'s fastest splits in every activity, plus efforts found inside analysed activities), with date and activity id, all-time and last 90 days. Race predictions are ESTIMATES from those efforts (Riegel formula), not Garmin\'s predictions (Garmin doesn\'t share those).',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: '"running" (default) or "cycling"' } } },
    async run(env, a) {
      const cycling = /cycl|bik|ride/.test(a.type || '');
      const acts = (await rows(env, 'activities', '2000-01-01', '2999-12-31')).filter(s => (cycling ? /cycl|bik|ride/ : isFoot)(s.activityType?.typeKey || ''));
      const GARMIN_KEYS = cycling ? [] : [['1000', '1k', 1000], ['1609', '1mile', 1609.34], ['5000', '5k', 5000], ['10000', '10k', 10000], ['21098', 'half_marathon', 21097.5], ['42195', 'marathon', 42195]];
      const efforts = {};
      const add = (name, D, t, s, src) => { if (!(t > 0)) return; (efforts[name] ||= { meters: D, list: [] }).list.push({ time_s: t, date: s.__day ?? s.date, id: String(s.__id ?? s.id), name: s.activityName ?? s.name ?? null, source: src }); };
      for (const s of acts) for (const [k, name, D] of GARMIN_KEYS) add(name, D, s[`fastestSplit_${k}`], s, 'garmin');
      const ana = await rows(env, 'analysis', '2000-01-01', '2999-12-31');
      const DIST = { '400m': 400, '1k': 1000, '1mile': 1609.34, '3k': 3000, '5k': 5000, '10k': 10000, '15k': 15000, half_marathon: 21097.5, marathon: 42195, '20k': 20000, '40k': 40000, '100k': 100000 };
      for (const x of ana) if ((cycling ? /cycl|bik|ride/.test(x.type || '') : isFoot(x.type || x.sport))) for (const [name, e] of Object.entries(x.best_efforts || {})) add(name, DIST[name], e.time_s, { __id: x.id, __day: x.__day, activityName: x.name }, 'file');
      const since = addDays(await today(env), -90);
      const best = list => list.reduce((b, e) => (!b || e.time_s < b.time_s ? e : b), null);
      const show = (e, D) => (e ? { time: fmtTime(e.time_s), pace_min_km: cycling ? null : paceStr(e.time_s / (D / 1000)), speed_kmh: cycling ? r(D / e.time_s * 3.6) : null, date: e.date, id: e.id, name: e.name } : null);
      const records = Object.fromEntries(Object.entries(efforts).sort((x, y) => x[1].meters - y[1].meters).map(([n, { meters, list }]) => {
        const dedup = [...new Map(list.map(e => [e.id, list.filter(z => z.id === e.id).reduce((b, z) => (z.time_s < b.time_s ? z : b))])).values()];
        return [n, { all_time: show(best(dedup), meters), last_90_days: show(best(dedup.filter(e => e.date >= since)), meters), top_3: dedup.sort((x, y) => x.time_s - y.time_s).slice(0, 3).map(e => show(e, meters)) }];
      }));
      // Riegel: T2 = T1 * (D2/D1)^1.06, from the longest recent effort (last 90 days, at least 3k).
      let predictions = null;
      if (!cycling) {
        const base = Object.entries(efforts).filter(([, v]) => v.meters >= 3000).map(([n, v]) => ({ n, D: v.meters, e: best(v.list.filter(e => e.date >= since)) })).filter(x => x.e).sort((x, y) => y.D - x.D)[0];
        if (base) predictions = { based_on: `${base.n} ${fmtTime(base.e.time_s)} on ${base.e.date}`, method: 'Riegel formula T2 = T1 x (D2/D1)^1.06: an ESTIMATE, assumes training for the distance', ...Object.fromEntries([['5k', 5000], ['10k', 10000], ['half_marathon', 21097.5], ['marathon', 42195]].map(([n, D]) => { const t = base.e.time_s * Math.pow(D / base.D, 1.06); return [n, { time: fmtTime(t), pace_min_km: paceStr(t / (D / 1000)) }]; })) };
      }
      return { type: cycling ? 'cycling' : 'running', activities_checked: acts.length, analysed_files: ana.length, records, race_predictions_estimated: predictions, not_available: 'Garmin\'s official personal-records list and race predictor aren\'t in its API; these are computed from your activities.' };
    },
  },
  {
    name: 'get_trends',
    description: 'How you are changing across workouts, per week (or month): sessions, km, time, training load, average pace and HR, efficiency factor (speed per heartbeat), pace at an easy HR (your zone 2), cadence, stride, ground contact, vertical oscillation and ratio, aerobic training effect. Filter by type (default running).',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'e.g. running (default), cycling, strength_training, swimming, or "all"' }, from: { type: 'string', description: 'Default 26 weeks ago' }, to: { type: 'string' }, by: { type: 'string', enum: ['week', 'month'] } } },
    async run(env, a) {
      const to = isDate(a.to) ? a.to : await today(env), from = isDate(a.from) ? a.from : addDays(to, -181);
      const type = String(a.type || 'running').toLowerCase();
      const all = await rows(env, 'activities', from, to);
      const list = all.filter(s => type === 'all' || (type === 'running' ? /run/.test(s.activityType?.typeKey || '') : (s.activityType?.typeKey || '').includes(type)));
      const z = await env.DB.prepare("SELECT data FROM summaries WHERE user_id = ?1 AND type = 'hrZones' AND id = 'current'").bind(OWNER).first();
      const zl = z ? JSON.parse(z.data).list : null;
      const zp = Array.isArray(zl) ? zl.find(x => x.sport === 'RUNNING') || zl.find(x => x.sport === 'DEFAULT') || zl[0] : null;
      const z2 = zp && zp.zone2Floor != null && zp.zone3Floor != null ? [zp.zone2Floor, zp.zone3Floor] : null;
      const key = d => (a.by === 'month' ? d.slice(0, 7) : weekStart(d));
      const groups = new Map();
      for (const s of list) { const k = key(s.__day); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
      const periods = [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, g]) => {
        const sp = s => (s.distance && (s.movingDuration ?? s.duration) ? s.distance / (s.movingDuration ?? s.duration) : s.averageSpeed);
        const foot = g.filter(s => isFoot(s.activityType?.typeKey));
        const easy = z2 ? foot.filter(s => s.averageHR >= z2[0] && s.averageHR < z2[1] && sp(s) > 0) : [];
        return {
          [a.by === 'month' ? 'month' : 'week_of']: k, sessions: g.length, km: r(g.reduce((s, x) => s + (x.distance || 0), 0) / 1000), hours: r(g.reduce((s, x) => s + (x.duration || 0), 0) / 3600, 2),
          training_load: r(g.reduce((s, x) => s + (x.activityTrainingLoad || 0), 0), 0), avg_aerobic_te: r(mean(g.map(x => x.aerobicTrainingEffect))),
          avg_pace_min_km: foot.length ? paceStr(1000 / mean(foot.map(sp))) : null, avg_hr_bpm: r(mean(g.map(x => x.averageHR)), 0),
          efficiency_factor: foot.length ? r(mean(foot.filter(s => s.averageHR && sp(s)).map(s => sp(s) * 60 / s.averageHR)), 2) : null,
          easy_runs_in_zone2: easy.length, pace_at_zone2_min_km: easy.length ? paceStr(1000 / mean(easy.map(sp))) : null,
          cadence_spm: r(mean(foot.map(x => x.averageRunningCadenceInStepsPerMinute)), 0), stride_cm: r(mean(foot.map(x => x.avgStrideLength))), ground_contact_ms: r(mean(foot.map(x => x.avgGroundContactTime)), 0),
          vertical_oscillation_cm: r(mean(foot.map(x => x.avgVerticalOscillation))), vertical_ratio_pct: r(mean(foot.map(x => x.avgVerticalRatio))), avg_power_w: r(mean(g.map(x => x.avgPower)), 0),
          longest_km: g.length ? r(Math.max(...g.map(x => (x.distance || 0) / 1000)), 2) : null,
        };
      });
      return { type, from, to, by: a.by === 'month' ? 'month' : 'week (Monday start)', zone2_bpm: z2, periods, note: 'Efficiency factor = metres per minute per heartbeat; rising = fitter. Pace at zone 2 compares runs done at an easy HR.' };
    },
  },
  {
    name: 'get_profile',
    description: 'Your physiology settings and how they changed: current HR zones per sport (max HR, LTHR, zone floors), the history of LTHR and max HR (saved daily from now on), fitness age history with what drives it (resting HR, vigorous days/minutes, BMI), resting HR by week, weight goal, units and preferred training days. VO2max history, Training Status and FTP are not in Garmin\'s API.',
    inputSchema: { type: 'object', properties: { weeks: { type: 'integer', description: 'History length, default 26' } } },
    async run(env, a) {
      const to = await today(env), from = addDays(to, -7 * Math.max(4, Math.min(104, parseInt(a.weeks, 10) || 26)));
      const zrow = await env.DB.prepare("SELECT data FROM summaries WHERE user_id = ?1 AND type = 'hrZones' AND id = 'current'").bind(OWNER).first();
      const zones = (zrow ? JSON.parse(zrow.data).list : []) || [];
      const fmtZ = z => ({ sport: z.sport?.toLowerCase?.() ?? null, method: z.trainingMethod?.toLowerCase?.() ?? null, max_hr_bpm: z.maxHeartRateUsed ?? null, lthr_bpm: z.lactateThresholdHeartRateUsed ?? null, resting_hr_bpm: z.restingHeartRateUsed ?? null, zone_floors_bpm: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor].map(v => v ?? null) });
      const hist = (await rows(env, 'hrZonesHistory', from, to)).map(h => ({ date: h.date, z: (h.list || []).find(x => x.sport === 'DEFAULT') || h.list?.[0] })).filter(h => h.z);
      const changes = hist.filter((h, i) => i === 0 || h.z.lactateThresholdHeartRateUsed !== hist[i - 1].z.lactateThresholdHeartRateUsed || h.z.maxHeartRateUsed !== hist[i - 1].z.maxHeartRateUsed).map(h => ({ date: h.date, lthr_bpm: h.z.lactateThresholdHeartRateUsed ?? null, max_hr_bpm: h.z.maxHeartRateUsed ?? null }));
      const fa = (await rows(env, 'fitnessAge', from, to)).map(f => { const x = Array.isArray(f.value) ? f.value[0] : f.value; return x ? { date: f.date, fitness_age: r(x.fitnessAge), achievable: r(x.achievableFitnessAge), age: x.chronologicalAge ?? null, drivers: x.components ? Object.fromEntries(Object.entries(x.components).map(([k, v]) => [k, v?.value ?? null])) : null } : null; }).filter(Boolean);
      const daily = await rows(env, 'dailies', from, to);
      const weeks = new Map();
      for (const d of daily) { const k = weekStart(d.calendarDate || d.__day); const v = d.heartRate?.restingValue; if (v != null) (weeks.get(k) || weeks.set(k, []).get(k)).push(v); }
      let settings = null, goal = null;
      const g = garmin(env);
      try { const s = await g.get(GARMIN.paths.settings); settings = { units: s?.measurementSystem?.toLowerCase?.() ?? null, first_day_of_week: s?.firstDayOfWeek?.dayName?.toLowerCase?.() ?? null, training_days: s?.availableTrainingDays ?? null, long_training_days: s?.preferredLongTrainingDays ?? null, time_zone: s?.timeZone ?? null }; } catch {}
      try { const w = await g.get(GARMIN.paths.weightGoals(addDays(to, -365), to)); const x = Array.isArray(w) ? w.at(-1) : w; const gr = x?.weightGoal ?? x?.goalValue ?? x?.highWeightGoalInGrams ?? null; goal = x ? { low_kg: x.lowWeightGoalInGrams ? r(x.lowWeightGoalInGrams / 1000) : null, high_kg: x.highWeightGoalInGrams ? r(x.highWeightGoalInGrams / 1000) : null, target_kg: typeof gr === 'number' && gr > 1000 ? r(gr / 1000) : null } : null; } catch {}
      return {
        hr_zones_now: zones.map(fmtZ), lthr_and_max_hr_history: changes, lthr_history_note: 'Saved once a day from the moment this was added; earlier values are not available from Garmin.',
        fitness_age_history: fa, resting_hr_by_week: [...weeks.entries()].sort().map(([k, v]) => ({ week_of: k, avg_bpm: r(mean(v), 0), lowest_bpm: Math.min(...v) })),
        weight_goal: goal, settings,
        not_available: 'VO2max (and its history), Training Status, Training Readiness, FTP history, Endurance and Hill Score are not in Garmin\'s Personal API.',
      };
    },
  },
];

function summarize(sets, kg) {
  if (!Array.isArray(sets) || !sets.length) return null;
  return sets.map(e => ({ exercise: String(e.category || e.subCategory || 'unknown').toLowerCase(), sub: e.subCategory ? String(e.subCategory).toLowerCase() : null, sets: e.sets ?? null, reps: e.reps ?? null, volume_kg: kg(e.volume), max_weight_kg: kg(e.maxWeight), duration_s: e.duration != null ? r(e.duration > 10000 ? e.duration / 1000 : e.duration, 0) : null }));
}
function weekStart(d) { const t = Date.parse(`${d}T12:00:00Z`); const wd = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - wd * 864e5).toISOString().slice(0, 10); }
