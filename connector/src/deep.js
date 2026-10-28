// The detailed layer: inside each activity (from its original file + Garmin's chart data) and inside each
// day (all-day HR, overnight HRV, Body Battery curve, SpO2). Fetched from Garmin once, processed here,
// and stored compact in D1 (raw files are not kept). Clock times are in your time zone (see store.js).
import { OWNER, garmin, save, addDays, setMeta, log, timeZone, localTime, today } from './store.js';
import { fitFromDownload, decodeFit } from './garmin/fit.js';
import { analyze, chartExtras, ANALYSIS_VERSION } from './garmin/analysis.js';

const gmtMs = v => (v == null ? null : typeof v === 'number' ? v : Date.parse(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`));

const row = (env, type, id) => env.DB.prepare('SELECT data, received FROM summaries WHERE user_id = ?1 AND type = ?2 AND id = ?3').bind(OWNER, type, String(id)).first();

// HR zone floors for an activity's sport (running zones for runs if set, else the default ones).
async function zoneFloors(env, sportKey) {
  const z = await row(env, 'hrZones', 'current');
  const list = z ? JSON.parse(z.data).list : null;
  if (!Array.isArray(list)) return null;
  const want = /run/.test(sportKey || '') ? 'RUNNING' : /cycl|bik|ride/.test(sportKey || '') ? 'CYCLING' : 'DEFAULT';
  const pick = list.find(x => x.sport === want) || list.find(x => x.sport === 'DEFAULT') || list[0];
  const f = pick ? [pick.zone1Floor, pick.zone2Floor, pick.zone3Floor, pick.zone4Floor, pick.zone5Floor] : null;
  return f?.every(v => typeof v === 'number') ? f : null;
}

// Everything inside one activity, computed once and kept. force = recompute.
export async function activityAnalysis(env, id, { force = false } = {}) {
  id = String(id).replace(/\D/g, '');
  if (!id) throw new Error('Give an activity id from get_activities.');
  if (!force) {
    const r = await row(env, 'analysis', id);
    if (r) { const a = JSON.parse(r.data); if (a.v === ANALYSIS_VERSION) return a; }
  }
  const g = garmin(env);
  const summary = await row(env, 'activities', id);
  const s = summary ? JSON.parse(summary.data) : null;
  let buf;
  try { buf = await g.download(id); } catch (e) {
    if (e.status === 404) throw new Error(`Garmin has no file for activity ${id} (manual entries have none).`);
    throw e;
  }
  const fit = decodeFit(await fitFromDownload(buf));
  const details = await g.details(id, 2000).catch(() => null);
  const a = analyze(fit, { extras: chartExtras(details), zones: await zoneFloors(env, s?.activityType?.typeKey) });
  a.id = id;
  a.name = s?.activityName ?? null;
  a.type = s?.activityType?.typeKey ?? a.sport;
  a.start_local = s?.startTimeLocal ? String(s.startTimeLocal).replace('T', ' ').slice(0, 16) : localTime(await timeZone(env), fit.sessions[0]?.start_time ?? fit.records[0]?.timestamp);
  a.garmin_summary = s ? { distance_km: s.distance != null ? Math.round(s.distance / 10) / 100 : null, moving_s: s.movingDuration ?? s.duration ?? null, avg_hr: s.averageHR ?? null } : null;
  const day = a.start_local?.slice(0, 10) || await today(env);
  await save(env, 'analysis', [a], () => ({ id, day }));
  return a;
}

// Background: analyse the newest not-yet-analysed activities (one per call, files can be large).
export async function analyzeRecent(env, days = 21) {
  const r = await env.DB.prepare(`SELECT s.id FROM summaries s WHERE s.user_id = ?1 AND s.type = 'activities' AND s.day >= ?2
    AND NOT EXISTS (SELECT 1 FROM summaries a WHERE a.user_id = s.user_id AND a.type = 'analysis' AND a.id = s.id)
    AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'noanalysis:' || s.id) ORDER BY s.day DESC LIMIT 1`).bind(OWNER, addDays(await today(env), -days)).first();
  if (!r) return null;
  try { await activityAnalysis(env, r.id); return r.id; } catch (e) {
    await setMeta(env, `noanalysis:${r.id}`, String(e.message).slice(0, 150));
    await log(env, 'analysis-skip', `${r.id}: ${String(e.message).slice(0, 120)}`);
    return null;
  }
}

// ---------- one day ----------
// Descriptor lists ([{key|...Key, index}]) -> index of a key.
const idx = (list, key) => { const d = (list || []).find(x => Object.entries(x).some(([k, v]) => /key$/i.test(k) && String(v).toLowerCase() === key.toLowerCase())); if (!d) return -1; const i = Object.entries(d).find(([k]) => /index$/i.test(k)); return i ? i[1] : -1; };

export async function dayDetail(env, date, { force = false } = {}) {
  const zone = await timeZone(env), local = ms => localTime(zone, ms); // clock times in your zone
  const cached = await row(env, 'day', date);
  const fresh = cached && (date < addDays(await today(env), -1) || Date.now() - cached.received < 30 * 60000);
  if (cached && fresh && !force) return JSON.parse(cached.data);
  const g = garmin(env);
  const get = p => p.catch(e => ({ __error: `${e.status || ''} ${e.message}`.trim() }));
  const [hr, hrv, sleep, us, spo2, bbRow] = await Promise.all([get(g.dailyHeartRate(date)), get(g.hrvDay(date)), get(g.sleepDay(date)), get(g.userSummary(date)), get(g.spo2(date)), row(env, 'bodyBattery', date)]);
  // The plain daily report has only a few points; asking for 96 chunks gives the low and high of every 15 minutes.
  let bb = bbRow ? JSON.parse(bbRow.data) : null;
  const curve = await get(g.get('/wellness-service/wellness/bodyBattery/reports/daily', { startDate: date, endDate: date, chunks: 96 }));
  const bbCurve = Array.isArray(curve) && curve[0] ? curve[0] : null;
  if (!bb && bbCurve) bb = bbCurve;
  const errors = Object.entries({ heart_rate: hr, hrv, sleep, summary: us, spo2 }).filter(([, v]) => v?.__error).map(([k, v]) => `${k}: ${v.__error}`);
  const ok = v => (v && !v.__error ? v : null);

  const H = ok(hr), V = ok(hrv), S = ok(sleep), U = ok(us), O = ok(spo2);
  const series = (vals, desc, valueKey, tsKey = 'timestamp') => {
    const ti = idx(desc, tsKey), vi = idx(desc, valueKey);
    return (vals || []).filter(x => Array.isArray(x) && x[ti] != null && x[vi] != null && x[vi] >= 0).map(x => [local(x[ti]).slice(11), x[vi]]);
  };
  const hrSeries = H ? (H.heartRateValues || []).filter(x => Array.isArray(x) && x[1] != null).map(x => [local(x[0]).slice(11), x[1]]) : [];
  const bbSrc = bbCurve?.bodyBatteryValuesArray?.length > (bb?.bodyBatteryValuesArray?.length || 0) ? bbCurve : bb;
  const bbSeries = bbSrc ? pickSeries(bbSrc.bodyBatteryValuesArray, bbSrc.bodyBatteryValueDescriptorDTOList, ['bodyBatteryLevel'], [0, 100], local) : [];
  const out = {
    date,
    heart_rate: H ? { resting_bpm: H.restingHeartRate ?? null, min_bpm: H.minHeartRate ?? null, max_bpm: H.maxHeartRate ?? null, resting_7d_avg_bpm: H.lastSevenDaysAvgRestingHeartRate ?? null, readings: hrSeries } : null,
    hrv_overnight: V ? { avg_ms: V.hrvSummary?.lastNightAvg ?? null, high_5min_ms: V.hrvSummary?.lastNight5MinHigh ?? null, weekly_avg_ms: V.hrvSummary?.weeklyAvg ?? null, status: V.hrvSummary?.status?.toLowerCase?.() ?? null, baseline_low_ms: V.hrvSummary?.baseline?.balancedLow ?? null, baseline_high_ms: V.hrvSummary?.baseline?.balancedUpper ?? null,
      sleep_start: local(gmtMs(V.sleepStartTimestampGMT)), sleep_end: local(gmtMs(V.sleepEndTimestampGMT)), readings: (V.hrvReadings || []).filter(x => x?.hrvValue != null).map(x => [local(gmtMs(x.readingTimeGMT))?.slice(11), x.hrvValue]) } : null,
    body_battery: bb ? { charged: bb.charged ?? null, drained: bb.drained ?? null, readings: bbSeries,
      events: (bb.bodyBatteryActivityEvent || []).map(e => ({ type: e.eventType?.toLowerCase?.() ?? null, start: local(gmtMs(e.eventStartTimeGmt)), min: e.durationInMilliseconds != null ? Math.round(e.durationInMilliseconds / 6000) / 10 : null, impact: e.bodyBatteryImpact ?? null, feedback: e.shortFeedback?.toLowerCase?.() ?? null })),
      feedback: bb.bodyBatteryDynamicFeedbackEvent?.feedbackLongType?.toLowerCase?.() ?? null, end_of_day_feedback: bb.endOfDayBodyBatteryDynamicFeedbackEvent?.feedbackLongType?.toLowerCase?.() ?? null } : null,
    spo2: O ? { avg_pct: O.averageSpO2 ?? null, lowest_pct: O.lowestSpO2 ?? null, sleep_avg_pct: O.avgSleepSpO2 ?? null, last_7d_avg_pct: O.lastSevenDaysAvgSpO2 ?? null,
      hourly: pickSeries(O.spO2HourlyAverages, O.spO2HourlyAveragesDescriptorList, ['spo2Reading', 'spo2Value', 'averageSpO2', 'spo2'], [50, 100], local),
      readings: pickSeries(O.spO2SingleValues, O.spO2SingleValuesDescriptorList, ['spo2Reading', 'spo2Value', 'spo2'], [50, 100], local),
      altitude_m: (O.monitoringEnvironmentValues || []).filter(x => Array.isArray(x) && x[1] != null).filter((_, i) => i % 6 === 0).map(x => [local(x[0]).slice(11), Math.round(x[1])]) } : null,
    summary: U ? {
      steps: U.totalSteps ?? null, step_goal: U.dailyStepGoal ?? null, distance_km: U.totalDistanceMeters != null ? Math.round(U.totalDistanceMeters / 10) / 100 : null, floors_up: U.floorsAscended != null ? Math.round(U.floorsAscended) : null, floors_down: U.floorsDescended != null ? Math.round(U.floorsDescended) : null,
      kcal_total: U.totalKilocalories ?? null, kcal_active: U.activeKilocalories ?? null, kcal_bmr: U.bmrKilocalories ?? null, kcal_consumed: U.consumedKilocalories ?? null,
      highly_active_min: sec(U.highlyActiveSeconds), active_min: sec(U.activeSeconds), sedentary_min: sec(U.sedentarySeconds), sleeping_min: sec(U.sleepingSeconds),
      moderate_intensity_min: U.moderateIntensityMinutes ?? null, vigorous_intensity_min: U.vigorousIntensityMinutes ?? null, intensity_goal_min: U.intensityMinutesGoal ?? null,
      resting_hr_bpm: U.restingHeartRate ?? null, min_avg_hr_bpm: U.minAvgHeartRate ?? null, max_avg_hr_bpm: U.maxAvgHeartRate ?? null, abnormal_hr_alerts: U.abnormalHeartRateAlertsCount ?? null,
      stress_avg: U.averageStressLevel >= 0 ? U.averageStressLevel : null, stress_max: U.maxStressLevel >= 0 ? U.maxStressLevel : null, stress_qualifier: U.stressQualifier?.toLowerCase?.() ?? null,
      stress_min: { rest: ms(U.restStressDuration), low: ms(U.lowStressDuration), medium: ms(U.mediumStressDuration), high: ms(U.highStressDuration), activity: ms(U.activityStressDuration), uncategorized: ms(U.uncategorizedStressDuration) },
      body_battery: { high: U.bodyBatteryHighestValue ?? null, low: U.bodyBatteryLowestValue ?? null, at_wake: U.bodyBatteryAtWakeTime ?? null, during_sleep_gain: U.bodyBatteryDuringSleep ?? null, latest: U.bodyBatteryMostRecentValue ?? null, charged: U.bodyBatteryChargedValue ?? null, drained: U.bodyBatteryDrainedValue ?? null },
      respiration_waking_avg_brpm: U.avgWakingRespirationValue ?? null, respiration_high_brpm: U.highestRespirationValue ?? null, respiration_low_brpm: U.lowestRespirationValue ?? null,
      spo2_avg_pct: U.averageSpo2 ?? null, spo2_lowest_pct: U.lowestSpo2 ?? null, hydration_ml: U.hydrationValueInML ?? null, hydration_goal_ml: U.hydrationGoalInML ?? null,
      jet_lag_day: U.isJetLagDay ?? null, wellness_start: U.wellnessStartTimeLocal ? String(U.wellnessStartTimeLocal).replace('T', ' ').slice(0, 16) : null, wellness_end: U.wellnessEndTimeLocal ? String(U.wellnessEndTimeLocal).replace('T', ' ').slice(0, 16) : null,
    } : null,
    sleep: S && S.sleepTimeSeconds != null ? {
      start: local(gmtMs(S.sleepStartTimestampGMT)), end: local(gmtMs(S.sleepEndTimestampGMT)), total_min: sec(S.sleepTimeSeconds), deep_min: sec(S.deepSleepSeconds), light_min: sec(S.lightSleepSeconds), rem_min: sec(S.remSleepSeconds), awake_min: sec(S.awakeSleepSeconds), unmeasurable_min: sec(S.unmeasurableSleepSeconds),
      awake_count: S.awakeCount ?? null, score: S.sleepScores?.overall?.value ?? null, quality: S.sleepScores?.overall?.qualifierKey?.toLowerCase?.() ?? null,
      score_parts: S.sleepScores ? Object.fromEntries(Object.entries(S.sleepScores).filter(([k]) => k !== 'overall').map(([k, v]) => [k, { value: v?.value ?? null, rating: v?.qualifierKey?.toLowerCase?.() ?? null }])) : null,
      feedback: S.sleepScoreFeedback?.toLowerCase?.() ?? null, insight: S.sleepScoreInsight?.toLowerCase?.() ?? null, personal_insight: S.sleepScorePersonalizedInsight?.toLowerCase?.() ?? null,
      avg_hr_bpm: S.avgHeartRate ?? null, avg_stress: S.avgSleepStress ?? null, respiration_avg_brpm: S.averageRespirationValue ?? null, respiration_low_brpm: S.lowestRespirationValue ?? null, respiration_high_brpm: S.highestRespirationValue ?? null,
      spo2_avg_pct: S.averageSpO2Value ?? null, spo2_lowest_pct: S.lowestSpO2Value ?? null, breathing_disruption: S.breathingDisruptionSeverity?.toLowerCase?.() ?? null,
      need_min: typeof S.sleepNeed === 'number' ? S.sleepNeed : S.sleepNeed?.actual ?? null, next_need_min: typeof S.nextSleepNeed === 'number' ? S.nextSleepNeed : S.nextSleepNeed?.actual ?? null,
      naps: (S.dailyNapDTOS || []).map(n => ({ start: local(gmtMs(n.napStartTimestampGMT)), end: local(gmtMs(n.napEndTimestampGMT)), min: sec(n.napTimeSec), feedback: n.napFeedback?.toLowerCase?.() ?? null })),
    } : null,
    not_available: 'Garmin\'s API has no minute-by-minute stress, breathing rate, steps or sleep-stage timeline; those are daily totals only.',
    errors: errors.length ? errors : null,
  };
  await save(env, 'day', [out], () => ({ id: date, day: date }));
  return out;
}
const sec = s => (s == null ? null : Math.round(s / 6) / 10);
// [[...], ...] rows described by a descriptor list -> [["HH:MM", value]]. Uses the named column if present,
// otherwise the non-time column whose values fall in `range` most often (Garmin's key names vary).
export function pickSeries(rowsIn, desc, names, range, clock) {
  const rows = (rowsIn || []).filter(Array.isArray);
  if (!rows.length) return [];
  let ti = idx(desc, 'timestamp');
  if (ti < 0) ti = 0;
  let vi = -1;
  for (const n of names) { vi = idx(desc, n); if (vi >= 0) break; }
  if (vi < 0) {
    let best = -1;
    for (let c = 0; c < rows[0].length; c++) {
      if (c === ti) continue;
      const n = rows.filter(x => typeof x[c] === 'number' && x[c] >= range[0] && x[c] <= range[1]).length;
      if (n > best) { best = n; vi = c; }
    }
  }
  return rows.filter(x => x[ti] != null && typeof x[vi] === 'number' && x[vi] >= range[0] && x[vi] <= range[1]).map(x => [clock(gmtMs(x[ti]))?.slice(11), x[vi]]);
}
const ms = v => (v == null ? null : Math.round(v / 6000) / 10);
