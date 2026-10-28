import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildFit, run, strength } from './fitgen.mjs';
import { decodeFit, fitFromDownload } from '../src/garmin/fit.js';
import { analyze, downsample, chartExtras } from '../src/garmin/analysis.js';

// Wrap a FIT file in a zip the way Garmin's download does (one deflated entry).
function zip(name, data) {
  const comp = zlib.deflateRawSync(data), nameB = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameB, comp]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cen.length + nameB.length, 12); eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cen, nameB, eocd]);
}

test('zip + FIT decode: records, events, lap, session', async () => {
  const fit = buildFit(run({ km: 3, pauseAt: 1 }));
  const z = zip('123_ACTIVITY.fit', Buffer.from(fit));
  const u8 = await fitFromDownload(z.buffer.slice(z.byteOffset, z.byteOffset + z.length));
  const d = decodeFit(u8);
  assert.equal(d.records.length, 901);
  assert.equal(d.laps.length, 1);
  assert.equal(d.sessions[0].sport, 1);
  assert.equal(d.records[10].heart_rate, 140);
  assert.equal(d.records[10].vertical_oscillation, 86); // mm
  assert.equal(d.records[10].stance_time, 245);
  assert.equal(d.events.length, 3);
});

test('one-lap 10 km run: per-km splits, pause excluded, best efforts, drift', () => {
  const a = analyze(decodeFit(buildFit(run({ km: 10, pace: 300, drift: 12, pauseAt: 5 }))), { zones: [120, 135, 145, 155, 170] });
  assert.equal(a.sport, 'running');
  assert.equal(a.laps.length, 1);
  assert.equal(a.splits_km.filter(s => !s.partial).length, 10);
  for (const s of a.splits_km.filter(s => !s.partial)) assert.equal(s.pace_min_km, '5:00', JSON.stringify(s));
  assert.equal(a.pauses.length, 1);
  assert.equal(a.pauses[0].duration_s, 60);
  assert.ok(Math.abs(a.pauses[0].at_km - 5) < 0.01);
  assert.equal(a.analysis.moving_time, '50:00');
  assert.equal(a.analysis.elapsed_time, '51:00');
  assert.equal(a.best_efforts['5k'].time, '25:00');
  assert.equal(a.best_efforts['1k'].pace_min_km, '5:00');
  assert.equal(a.best_efforts['10k'].time, '50:00');
  assert.equal(a.best_efforts.half_marathon, undefined);
  assert.ok(a.analysis.hr_drift_bpm >= 5 && a.analysis.hr_drift_bpm <= 7, `drift ${a.analysis.hr_drift_bpm}`);
  assert.ok(a.analysis.decoupling_pct > 2 && a.analysis.decoupling_pct < 6, `decoupling ${a.analysis.decoupling_pct}`);
  assert.equal(a.analysis.avg_cadence, 170);
  assert.equal(a.analysis.avg_vertical_oscillation_cm, 8.6);
  assert.equal(a.analysis.avg_ground_contact_ms, 245);
  assert.equal(a.analysis.avg_vertical_ratio_pct, 7.8);
  assert.equal(a.analysis.avg_stride_m, 1.15);
  assert.equal(a.analysis.avg_gct_balance_left_pct, 49.8);
  assert.equal(a.analysis.avg_power, 250);
  const z = a.analysis.hr_zones; const tot = z.below_z1_min + z.z1_min + z.z2_min + z.z3_min + z.z4_min + z.z5_min;
  assert.ok(Math.abs(tot - 50) < 0.2, `zones total ${tot}`);
  assert.ok(Math.abs(a.analysis.efficiency_factor - 3.33 * 60 / 146) < 0.05);
  assert.equal(a.analysis.negative_split_s_per_km, 0);
  assert.equal(a.analysis.km_pace_variability_pct, 0);
  const ds = downsample(a.series, 50);
  assert.ok(ds.rows.length >= 45 && ds.rows.length <= 55, `rows ${ds.rows.length}`);
  assert.deepEqual(ds.columns.slice(0, 4), ['min', 'km', 'pace_min_km', 'hr_bpm']);
  assert.equal(ds.rows[10][2], '5:00');
});

test('hilly run: climb counted per km, grade-adjusted pace from Garmin chart extras', () => {
  const fit = decodeFit(buildFit(run({ km: 6, pace: 330, hill: true, pauseAt: null })));
  const t0 = fit.records[0].timestamp;
  const details = { metricDescriptors: [{ metricsIndex: 0, key: 'directTimestamp' }, { metricsIndex: 1, key: 'directGradeAdjustedSpeed' }, { metricsIndex: 2, key: 'directAvailableStamina' }, { metricsIndex: 3, key: 'directBodyBattery' }],
    activityDetailMetrics: Array.from({ length: 100 }, (_, i) => ({ metrics: [t0 + i * 20000, 3.2, 100 - i * 0.3, 80 - Math.floor(i / 10)] })) };
  const a = analyze(fit, { extras: chartExtras(details) });
  assert.ok(a.analysis.elev_gain_m >= 45 && a.analysis.elev_gain_m <= 51, `gain ${a.analysis.elev_gain_m}`);
  assert.ok(a.splits_km[0].elev_gain_m > 5 && a.splits_km[5].elev_loss_m > 5);
  assert.ok(['5:12', '5:13'].includes(a.splits_km[0].grade_adjusted_pace_min_km)); // 3.2 m/s = 5:12.5
  assert.equal(a.analysis.stamina_start_pct, 100);
  assert.ok(a.analysis.body_battery_end < a.analysis.body_battery_start);
  assert.ok(a.series.stamina && a.series.gap && a.series.body_battery);
});

test('strength: sets with exercise, reps, weight; rests marked', () => {
  const a = analyze(decodeFit(buildFit(strength())));
  assert.equal(a.sets.length, 6);
  assert.deepEqual(a.sets[0], { set: 1, type: 'active', exercise: 'bench_press', exercise_subtype: 5, reps: 10, weight_kg: 60, duration_s: 45 });
  assert.equal(a.sets[1].type, 'rest');
  assert.equal(a.sets[1].reps, null);
  assert.equal(a.sets[2].weight_kg, 61);
});

test('multisport: each session is a leg', () => {
  const legs = [...run({ km: 2, pace: 360, pauseAt: null, sport: 1 }), ...run({ start: Date.UTC(2026, 9, 20, 4, 15), km: 3, pace: 120, pauseAt: null, sport: 2 })];
  const a = analyze(decodeFit(buildFit(legs)));
  assert.equal(a.legs.length, 2);
  assert.equal(a.legs[0].sport, 'running'); assert.equal(a.legs[0].pace_min_km, '6:00');
  assert.equal(a.legs[1].sport, 'cycling'); assert.equal(a.legs[1].speed_kmh, 30);
});

test('missing channels are left out, not zeros', () => {
  const a = analyze(decodeFit(buildFit(strength())));
  assert.equal(a.series.pwr, undefined);
  assert.equal(a.analysis.avg_power, null);
});

test('speed: 2h run with 1 s records decodes and analyses quickly', () => {
  const buf = buildFit(run({ km: 24, pace: 300 }));
  const t = performance.now();
  const a = analyze(decodeFit(buf));
  const ms = performance.now() - t;
  assert.ok(a.series.t_s.length <= 1500);
  console.log(`  7200 records: ${ms.toFixed(1)} ms, file ${buf.length} bytes`);
});
