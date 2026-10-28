// End to end: fake Garmin (serves zipped FIT files, chart data and day data) + a real SQLite copy of the
// schema behind a tiny D1 shim. Runs the sync and every detailed tool. Needs Node 22.5+ (node:sqlite).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { buildFit, run, strength } from './fitgen.mjs';

function zip(name, data) {
  const comp = zlib.deflateRawSync(data), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28);
  const body = Buffer.concat([local, n, comp]); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cen, n, eocd]);
}
// The fake account lives in Dubai (UTC+4, no daylight saving), so local times are easy to check.
const ZONE = 'Asia/Dubai';
const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
const day = n => new Date(Date.parse(localToday) - n * 864e5).toISOString().slice(0, 10);
const runStart = Date.parse(`${day(1)}T04:00:00Z`);
const FILES = {
  101: zip('101_ACTIVITY.fit', Buffer.from(buildFit(run({ start: runStart, km: 8, pace: 315, drift: 10, pauseAt: 4 })))),
  102: zip('102_ACTIVITY.fit', Buffer.from(buildFit(strength({ start: Date.parse(`${day(2)}T15:00:00Z`) })))),
  103: zip('103_ACTIVITY.fit', Buffer.from(buildFit([...run({ start: Date.parse(`${day(3)}T05:00:00Z`), km: 2, pace: 360, pauseAt: null }), ...run({ start: Date.parse(`${day(3)}T05:15:00Z`), km: 4, pace: 120, pauseAt: null, sport: 2 })]))),
};
const acts = [
  { activityId: 101, activityName: 'Easy run', startTimeLocal: `${day(1)} 07:00:00`, beginTimestamp: runStart, activityType: { typeKey: 'running' }, distance: 8000, duration: 2520, movingDuration: 2520, averageSpeed: 3.17, averageHR: 145, averageRunningCadenceInStepsPerMinute: 170, avgGroundContactTime: 245, avgVerticalOscillation: 8.6, avgVerticalRatio: 7.8, avgStrideLength: 115, fastestSplit_1000: 314, fastestSplit_5000: 1580, activityTrainingLoad: 80, aerobicTrainingEffect: 3 },
  { activityId: 102, activityName: 'Strength', startTimeLocal: `${day(2)} 17:00:00`, activityType: { typeKey: 'strength_training' }, duration: 540, totalSets: 3, activeSets: 3, totalReps: 24, summarizedExerciseSets: [{ category: 'BENCH_PRESS', reps: 24, volume: 1464000, sets: 3, maxWeight: 62000, duration: 135000 }] },
  { activityId: 103, activityName: 'Duathlon', startTimeLocal: `${day(3)} 07:00:00`, activityType: { typeKey: 'multi_sport' }, isParent: true, distance: 6000, duration: 1920 },
  { activityId: 104, activityName: 'Old run', startTimeLocal: `${day(120)} 07:00:00`, activityType: { typeKey: 'running' }, distance: 10000, duration: 2900, averageHR: 150, fastestSplit_1000: 280, fastestSplit_5000: 1450, fastestSplit_10000: 2900 },
];
const T = d => Date.parse(`${d}T00:00:00Z`);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p.endsWith('/personal-api-key/token')) return j({ access_token: 'tok', expires_in: 86400 });
  if (req.headers.authorization !== 'Bearer tok') return j({}, 401);
  let m;
  if (p === '/activitylist-service/activities/search/activities') return j(acts.filter(a => a.startTimeLocal.slice(0, 10) >= q.get('startDate') && a.startTimeLocal.slice(0, 10) <= q.get('endDate')).slice(+q.get('start'), +q.get('start') + +q.get('limit')));
  if ((m = p.match(/^\/download-service\/files\/activity\/(\d+)$/))) { const f = FILES[m[1]]; if (!f) return j({}, 404); res.writeHead(200, { 'Content-Type': 'application/x-zip-compressed' }); return res.end(f); }
  if ((m = p.match(/^\/activity-service\/activity\/(\d+)\/details$/))) {
    if (m[1] !== '101') return j({ metricDescriptors: [], activityDetailMetrics: [] });
    return j({ metricDescriptors: [{ metricsIndex: 0, key: 'directTimestamp' }, { metricsIndex: 1, key: 'directGradeAdjustedSpeed' }, { metricsIndex: 2, key: 'directAvailableStamina' }, { metricsIndex: 3, key: 'directBodyBattery' }], activityDetailMetrics: Array.from({ length: 140 }, (_, i) => ({ metrics: [runStart + i * 20000, 3.2, 100 - i * 0.2, 75 - Math.floor(i / 14)] })) });
  }
  if ((m = p.match(/^\/activity-service\/activity\/(\d+)$/))) return j({ activityId: +m[1], isMultiSportParent: m[1] === '103', activityTypeDTO: { typeKey: acts.find(a => a.activityId === +m[1])?.activityType.typeKey }, metadataDTO: { childIds: m[1] === '103' ? [1031, 1032] : [] }, summaryDTO: { startTimeLocal: `${day(1)}T07:00:00.0` } });
  if (p.match(/\/workouts$/)) return j([]);
  if (p === '/usersummary-service/v2/dailysummaries') return j({ data: [] });
  if (p === '/sleep-service/sleep/dailySleepSummariesByDate') return j([]);
  if (p.startsWith('/hrv-service/hrv/daily/')) return j({ hrvSummaries: [] });
  if (p === '/wellness-service/wellness/bodyBattery/reports/daily') return j([{ date: q.get('startDate'), charged: 60, drained: 55, bodyBatteryValueDescriptorDTOList: [{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: 'timestamp' }, { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' }], bodyBatteryValuesArray: Array.from({ length: 96 }, (_, i) => [T(q.get('startDate')) - 2 * 3600e3 + i * 900e3, 30 + (i % 40)]), bodyBatteryActivityEvent: [{ eventType: 'SLEEP', eventStartTimeGmt: `${q.get('startDate')}T20:00:00.0`, durationInMilliseconds: 27e6, bodyBatteryImpact: 50 }] }]);
  if (p.startsWith('/weight-service/weight/range/')) return j({ dailyWeightSummaries: [] });
  if (p === '/biometric-service/heartRateZones/v2') return j([{ sport: 'DEFAULT', trainingMethod: 'LACTATE_THRESHOLD', lactateThresholdHeartRateUsed: 168, maxHeartRateUsed: 190, zone1Floor: 120, zone2Floor: 135, zone3Floor: 148, zone4Floor: 160, zone5Floor: 172 }]);
  if (p.startsWith('/fitnessage-service/')) return j({ chronologicalAge: 35, fitnessAge: 30.2, achievableFitnessAge: 28, components: { rhr: { value: 50 }, bmi: { value: 23.1 } } });
  if (p === '/wellness-service/wellness/dailyHeartRate') { const d = q.get('date'); return j({ calendarDate: d, restingHeartRate: 50, minHeartRate: 46, maxHeartRate: 165, lastSevenDaysAvgRestingHeartRate: 51, heartRateValueDescriptors: [{ key: 'timestamp', index: 0 }, { key: 'heartrate', index: 1 }], heartRateValues: Array.from({ length: 720 }, (_, i) => [T(d) - 2 * 3600e3 + i * 120e3, i % 7 ? 60 + (i % 30) : null]) }); }
  if ((m = p.match(/^\/hrv-service\/hrv\/([\d-]+)$/))) return j({ hrvSummary: { lastNightAvg: 55, lastNight5MinHigh: 80, weeklyAvg: 57, status: 'BALANCED', baseline: { balancedLow: 50, balancedUpper: 65 } }, hrvReadings: Array.from({ length: 90 }, (_, i) => ({ hrvValue: 50 + (i % 10), readingTimeGMT: new Date(T(m[1]) - 3 * 3600e3 + i * 300e3).toISOString().replace('Z', '') })), sleepStartTimestampGMT: new Date(T(m[1]) - 3 * 3600e3).toISOString().replace('Z', ''), sleepEndTimestampGMT: new Date(T(m[1]) + 4 * 3600e3).toISOString().replace('Z', '') });
  if (p === '/sleep-service/sleep/dailySleep') return j({ sleepTimeSeconds: 25200, deepSleepSeconds: 5000, lightSleepSeconds: 14000, remSleepSeconds: 5400, awakeSleepSeconds: 800, sleepStartTimestampGMT: T(q.get('date')) - 3 * 3600e3, sleepEndTimestampGMT: T(q.get('date')) + 4 * 3600e3, sleepScores: { overall: { value: 81, qualifierKey: 'GOOD' }, remPercentage: { value: 21, qualifierKey: 'GOOD' } }, dailyNapDTOS: [{ napTimeSec: 1200, napStartTimestampGMT: `${q.get('date')}T12:00:00.0`, napEndTimestampGMT: `${q.get('date')}T12:20:00.0` }], lowestRespirationValue: 11, highestRespirationValue: 18 });
  if (p === '/usersummary-service/usersummary/daily') return j({ totalSteps: 11234, totalKilocalories: 2500, bmrKilocalories: 1700, sedentarySeconds: 30000, activeSeconds: 6000, avgWakingRespirationValue: 15, averageStressLevel: 30, restStressDuration: 20000, abnormalHeartRateAlertsCount: 0 });
  if (p.startsWith('/wellness-service/wellness/daily/spo2acclimation/')) return j({ averageSpO2: 96, lowestSpO2: 90, spO2HourlyAveragesDescriptorList: [{ spo2ValueDescIndex: 0, spo2ValueDescKey: 'timestamp' }, { spo2ValueDescIndex: 1, spo2ValueDescKey: 'spo2Reading' }], spO2HourlyAverages: [[T(day(1)), 95], [T(day(1)) + 3600e3, 96]] });
  if (p === '/userprofile-service/userprofile/settings') return j({ measurementSystem: 'METRIC', timeZone: ZONE, displayName: 'private-name' });
  if (p.startsWith('/goal-service/')) return j([]);
  return j({}, 404);
});

// D1 shim over node:sqlite; the tables come from src/schema.js, like on Cloudflare.
export function d1() {
  const db = new DatabaseSync(':memory:');
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), all: async () => ({ results: db.prepare(sql).all(...norm(args)) }), first: async () => db.prepare(sql).get(...norm(args)) ?? null, run: async () => ({ meta: { changes: db.prepare(sql).run(...norm(args)).changes } }) });
  return { prepare: sql => stmt(sql), batch: async l => { for (const s of l) await s.run(); return []; } };
}

test('end to end against a fake Garmin', async () => {
  await new Promise(r => server.listen(18765, r));
  const env = { DB: d1(), GARMIN_API_KEY: 'k', OWNER_PASSWORD: 'a long test password', GARMIN_BASE: 'http://localhost:18765' };
  try {
    await (await import('../src/schema.js')).ensureSchema(env);
    const store = await import('../src/store.js');
    const r = await store.syncRecent(env);
    assert.deepEqual(r.errors, []);
    assert.equal(await store.timeZone(env), ZONE); // from the Garmin settings
    assert.equal(await store.today(env), localToday);
    for (const k of ['activities']) await store.pull(env, k, day(150), day(0));
    const { TOOLS } = await import('../src/tools.js');
    const t = n => TOOLS.find(x => x.name === n);
    assert.equal(TOOLS.length, 18);

    const st = await t('get_activity_streams').run(env, { id: '101', points: 40 });
    assert.ok(st.rows.length >= 35 && st.rows.length <= 45, `rows ${st.rows.length}`);
    for (const c of ['pace_min_km', 'hr_bpm', 'cadence', 'vertical_oscillation_cm', 'ground_contact_ms', 'grade_adjusted_pace_min_km', 'stamina_pct', 'body_battery']) assert.ok(st.columns.includes(c), c);
    assert.ok(st.channels_recorded.includes('stamina'));
    const only = await t('get_activity_streams').run(env, { id: '101', points: 20, channels: ['hr', 'vertical_oscillation'] });
    assert.deepEqual(only.columns, ['min', 'km', 'hr_bpm', 'vertical_oscillation_cm']);

    const sp = await t('get_splits').run(env, { id: '101' });
    assert.equal(sp.splits_km.filter(s => !s.partial).length, 8);
    assert.equal(sp.splits_km[0].pace_min_km, '5:15');
    assert.equal(sp.laps.length, 1);

    const an = await t('analyze_activity').run(env, { id: '101' });
    assert.equal(an.pauses.length, 1);
    assert.equal(an.best_efforts['5k'].time, '26:15');
    assert.ok(an.analysis.decoupling_pct > 0 && an.analysis.hr_drift_bpm > 0);
    assert.ok(an.analysis.hr_zones.z2_min + an.analysis.hr_zones.z3_min > 30);
    assert.equal(an.analysis.stamina_start_pct, 100);
    assert.ok(Object.values(an.analysis).includes(null) || true); // nulls allowed, never undefined
    assert.ok(!Object.values(an.analysis).includes(undefined));

    const gs = await t('get_strength').run(env, { id: '102' });
    assert.equal(gs.sets.filter(s => s.type === 'active').length, 3);
    assert.equal(gs.sets[0].exercise, 'bench_press');
    assert.equal(gs.per_exercise[0].max_weight_kg, 62);
    const gl = await t('get_strength').run(env, {});
    assert.equal(gl.workouts.length, 1);
    assert.equal(gl.per_exercise_totals[0].exercise, 'bench_press');

    const g1 = await t('get_activity').run(env, { id: '101' });
    assert.ok(!('splits' in g1), 'renamed to split_summaries');
    const ga = await t('get_activity').run(env, { id: '103' });
    assert.equal(ga.legs.length, 2);
    assert.deepEqual(ga.legs.map(l => l.sport), ['running', 'cycling']);
    assert.deepEqual(ga.child_activity_ids, ['1031', '1032']);

    const gd = await t('get_day').run(env, { date: day(1), every_min: 30 });
    assert.equal(gd.heart_rate.resting_bpm, 50);
    assert.ok(gd.heart_rate.curve.length >= 40 && gd.heart_rate.curve.length <= 48, `curve ${gd.heart_rate.curve.length}`);
    assert.equal(gd.heart_rate.curve[0][0], '00:00'); // local midnight first
    assert.equal(gd.hrv_overnight.readings.length, 90);
    assert.equal(gd.hrv_overnight.readings[0][0], '01:00'); // 21:00 UTC = 01:00 in Dubai
    assert.equal(gd.sleep.naps.length, 1);
    assert.equal(gd.summary.steps, 11234);
    assert.equal(gd.summary.kcal_bmr, 1700);
    assert.equal(gd.summary.floors_up, null); // missing -> null
    assert.equal(gd.spo2.hourly.length, 2);
    assert.equal(gd.workouts.length, 1);
    assert.ok(gd.body_battery.curve.length > 10);

    const rec = await t('get_records').run(env, {});
    assert.equal(rec.records['1k'].all_time.time, '4:40');
    assert.equal(rec.records['5k'].last_90_days.time, '26:15'); // from the file (better than Garmin's 26:20)
    assert.equal(rec.records['5k'].all_time.time, '24:10');
    assert.ok(rec.race_predictions_estimated.marathon.time);

    const tr = await t('get_trends').run(env, {});
    assert.ok(tr.periods.length >= 2);
    assert.deepEqual(tr.zone2_bpm, [135, 148]);
    assert.equal(tr.periods.at(-1).pace_at_zone2_min_km, '5:15');

    const pr = await t('get_profile').run(env, {});
    assert.equal(pr.hr_zones_now[0].lthr_bpm, 168);
    assert.equal(pr.lthr_and_max_hr_history.length, 1);
    assert.equal(pr.settings.units, 'metric');
    assert.ok(!JSON.stringify(pr).includes('private-name'));

    // old tools still answer the same way
    const acts = await t('get_activities').run(env, { from: day(5), to: day(0) });
    assert.equal(acts.count, 3);
    const tg = await t('get_training').run(env, {});
    assert.match(tg.not_available, /get_profile/);

    // background analysis picks up nothing new (all done) without errors
    const { analyzeRecent } = await import('../src/deep.js');
    assert.equal(await analyzeRecent(env), null);
  } finally { server.close(); }
});

test('time zone: Garmin settings, else the TZ variable, else UTC', async () => {
  const store = await import('../src/store.js');
  const env = { DB: d1(), TZ: 'America/New_York' };
  await env.DB.prepare('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated INTEGER NOT NULL)').run();
  assert.equal(await store.timeZone(env), 'America/New_York');
  assert.equal(await store.timeZone({ DB: d1Meta(), TZ: 'Not/AZone' }), 'UTC'); // a bad TZ value falls back to UTC
  assert.equal(store.localTime('America/New_York', Date.UTC(2026, 0, 1, 3, 30)), '2025-12-31 22:30');
  assert.equal(store.localTime('UTC', Date.UTC(2026, 0, 1, 3, 30)), '2026-01-01 03:30');
});
function d1Meta() { const db = d1(); db.prepare('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated INTEGER NOT NULL)').run(); return db; }
