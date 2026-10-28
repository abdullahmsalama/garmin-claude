// Turns Garmin Connect API objects into small objects with plain units (km, min, bpm, ms, kg).
// Missing fields are dropped, so anything Garmin doesn't send simply doesn't appear.

const r1 = v => (v == null || !isFinite(v) ? undefined : Math.round(v * 10) / 10);
const r2 = v => (v == null || !isFinite(v) ? undefined : Math.round(v * 100) / 100);
const min = s => (s == null || !isFinite(s) ? undefined : r1(s / 60));
const km = m => (m == null || !isFinite(m) ? undefined : r2(m / 1000));
export const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
export function pace(mps) {
  if (!mps || mps <= 0.3) return undefined; // slower than ~55 min/km: not a pace
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// "2026-10-24 07:31:00", ISO, or epoch ms whose clock is already local -> "2026-10-24 07:31"
export function localTime(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 16).replace('T', ' ');
  return String(v).replace('T', ' ').slice(0, 16);
}
const label = v => (typeof v === 'string' && v && !/^(unknown|none|no_data)$/i.test(v) ? v.toLowerCase() : undefined);
const kg = v => (v == null ? undefined : r1(v > 1000 ? v / 1000 : v)); // Garmin may give grams
const isRun = t => /run|walk|hik|treadmill|track/i.test(t || '');

// Activity from the activity list (SummarizedActivityDTO).
export function activity(a) {
  const type = a.activityType?.typeKey;
  const zones = [1, 2, 3, 4, 5].map(i => a[`hrTimeInZone_${i}`]);
  return clean({
    id: a.activityId != null ? String(a.activityId) : undefined,
    date: a.startTimeLocal?.slice(0, 10),
    start: localTime(a.startTimeLocal),
    type,
    name: a.activityName,
    km: km(a.distance),
    min: min(a.movingDuration ?? a.duration),
    elapsed_min: a.elapsedDuration && a.duration && a.elapsedDuration - a.duration > 60 ? min(a.elapsedDuration) : undefined,
    pace_min_km: isRun(type) ? pace(a.distance && (a.movingDuration ?? a.duration) ? a.distance / (a.movingDuration ?? a.duration) : a.averageSpeed) : undefined,
    speed_kmh: !isRun(type) && a.averageSpeed ? r1(a.averageSpeed * 3.6) : undefined,
    avg_hr_bpm: a.averageHR != null ? Math.round(a.averageHR) : undefined,
    max_hr_bpm: a.maxHR != null ? Math.round(a.maxHR) : undefined,
    cadence_spm: a.averageRunningCadenceInStepsPerMinute ? Math.round(a.averageRunningCadenceInStepsPerMinute) : undefined,
    climb_m: a.elevationGain != null ? Math.round(a.elevationGain) : undefined,
    kcal: a.calories != null ? Math.round(a.calories) : undefined,
    avg_power_w: a.avgPower != null ? Math.round(a.avgPower) : undefined,
    training_load: a.activityTrainingLoad != null ? Math.round(a.activityTrainingLoad) : undefined,
    aerobic_te: r1(a.aerobicTrainingEffect),
    anaerobic_te: r1(a.anaerobicTrainingEffect),
    te_label: label(a.trainingEffectLabel),
    vo2max: a.vO2MaxValue || undefined,
    hr_zones_min: zones.some(z => z != null) ? Object.fromEntries(zones.map((z, i) => [`z${i + 1}`, min(z || 0)])) : undefined,
    stride_cm: a.avgStrideLength ? r1(a.avgStrideLength) : undefined,
    ground_contact_ms: a.avgGroundContactTime ? Math.round(a.avgGroundContactTime) : undefined,
    vertical_osc_cm: a.avgVerticalOscillation ? r1(a.avgVerticalOscillation) : undefined,
    is_pr: a.isPR || undefined,
  });
}

// Extra detail from /activity-service/activity/{id} (ActivitySummaryDTO) + its workouts.
export function activityDetail(d, workouts) {
  const s = d?.summaryDTO || {};
  const type = d?.activityTypeDTO?.typeKey;
  return clean({
    description: d?.description,
    location: d?.locationName,
    timezone: d?.timeZoneUnitDTO?.timeZone,
    recovery_hr_bpm: s.recoveryHeartRate,
    lactate_threshold_hr_bpm: s.lactateThresholdHeartRate,
    grade_adjusted_pace_min_km: isRun(type) ? pace(s.avgGradeAdjustedSpeed) : undefined,
    rpe_1_10: s.directWorkoutRpe != null ? (s.directWorkoutRpe > 10 ? s.directWorkoutRpe / 10 : s.directWorkoutRpe) : undefined, feel: s.directWorkoutFeel, perceived_effort: s.perceivedWorkoutEffort,
    workout_compliance: s.directWorkoutComplianceScore,
    body_battery_change: s.differenceBodyBattery,
    avg_respiration_brpm: r1(s.avgRespirationRate),
    stamina_start_pct: s.beginPotentialStamina, stamina_end_pct: s.endPotentialStamina,
    temp_c: r1(s.averageTemperature),
    // Garmin's split summaries: one total per segment type (interval, run/walk…), not laps or km splits.
    split_summaries: (d?.splitSummaries || []).filter(x => x.splitType).map(x => clean({
      type: x.splitType.toLowerCase(), count: x.noOfSplits, km: km(x.distance), min: min(x.movingDuration ?? x.duration),
      pace_min_km: isRun(type) ? pace(x.distance && x.duration ? x.distance / (x.movingDuration ?? x.duration) : x.averageSpeed) : undefined,
      avg_hr_bpm: x.averageHR != null ? Math.round(x.averageHR) : undefined, max_hr_bpm: x.maxHR != null ? Math.round(x.maxHR) : undefined,
    })),
    planned_workout: (Array.isArray(workouts) ? workouts : []).map(w => clean({
      name: w.workoutName, sport: w.sport,
      steps: (w.steps || []).map(st => clean({ step: st.stepIndex, name: st.name, intensity: st.intensity?.toLowerCase?.(), duration: stepDuration(st), target: stepTarget(st), notes: st.notes })),
    })),
  });
}

// Planned workout steps: time in seconds and distance in meters; pace/speed targets in m/s.
function stepDuration(st) {
  const t = String(st.durationType || '').toLowerCase(), v = st.durationValue;
  if (!t) return undefined;
  if (v != null && /time/.test(t)) return `${r1(v / 60)} min`;
  if (v != null && /distance/.test(t)) return `${r2(v / 1000)} km`;
  return v != null ? `${v} ${t}` : t;
}
function stepTarget(st) {
  const t = String(st.targetType || '').toLowerCase();
  if (!t || /no[._ ]?target|open/.test(t)) return undefined;
  if (/pace|speed/.test(t) && (st.targetValueLow || st.targetValueHigh)) {
    const [a, b] = [st.targetValueLow, st.targetValueHigh].filter(Boolean).sort((x, y) => y - x); // faster speed = faster pace first
    return clean({ type: 'pace', pace_min_km: [pace(a), pace(b)].filter(Boolean).join('-') });
  }
  return clean({ type: t, value: st.targetValue, low: st.targetValueLow, high: st.targetValueHigh });
}

// One day from /usersummary-service/v2/dailysummaries.
export function daily(d) {
  const ms = v => (v == null ? undefined : r1(v / 60000));
  return clean({
    date: d.calendarDate,
    steps: d.movement?.steps?.value,
    km: km(d.movement?.steps?.distanceInMeters),
    floors: d.movement?.floorsAscended?.value != null ? Math.round(d.movement.floorsAscended.value) : undefined,
    active_kcal: d.calories?.burnedActive != null ? Math.round(d.calories.burnedActive) : undefined,
    total_kcal: d.calories?.burnedTotal != null ? Math.round(d.calories.burnedTotal) : undefined,
    resting_hr_bpm: d.heartRate?.restingValue,
    min_hr_bpm: d.heartRate?.minValue,
    max_hr_bpm: d.heartRate?.maxValue,
    moderate_min: d.intensityMinutes?.moderate,
    vigorous_min: d.intensityMinutes?.vigorous,
    avg_stress: d.stress?.avgLevel >= 0 ? d.stress.avgLevel : undefined,
    max_stress: d.stress?.maxLevel >= 0 ? d.stress.maxLevel : undefined,
    stress_qualifier: label(d.stress?.qualifier),
    rest_min: ms(d.stress?.restDurationInMillis),
    low_stress_min: ms(d.stress?.lowStressDurationInMillis),
    medium_stress_min: ms(d.stress?.mediumStressDurationInMillis),
    high_stress_min: ms(d.stress?.highStressDurationInMillis),
    body_battery_high: d.bodyBattery?.maxValue,
    body_battery_low: d.bodyBattery?.minValue,
    body_battery_charged: d.bodyBattery?.chargedValue,
    body_battery_drained: d.bodyBattery?.drainedValue,
    body_battery_end: d.bodyBattery?.endOfDayValue ?? d.bodyBattery?.latestValue,
    respiration_brpm: r1(d.respiration?.avgValue),
    spo2_pct: d.pulseOx?.avgValue,
  });
}

// One night from /sleep-service/sleep/dailySleepSummariesByDate.
export function sleep(s) {
  const sc = s.sleepScores || {};
  const score = sc.overall?.value ?? sc.totalScore?.value;
  return clean({
    date: s.calendarDate,
    start: localTime(s.sleepStartTimestampLocal),
    end: localTime(s.sleepEndTimestampLocal),
    total_min: min(s.sleepTimeSeconds),
    deep_min: min(s.deepSleepSeconds),
    light_min: min(s.lightSleepSeconds),
    rem_min: min(s.remSleepSeconds),
    awake_min: min(s.awakeSleepSeconds),
    awake_count: s.awakeCount,
    nap_min: s.napTimeSeconds ? min(s.napTimeSeconds) : undefined,
    score,
    quality: sc.overall?.qualifierKey?.toLowerCase?.(),
    feedback: s.sleepScoreFeedback?.toLowerCase?.(),
    avg_hr_bpm: s.avgHeartRate != null ? Math.round(s.avgHeartRate) : undefined,
    avg_stress: s.avgSleepStress != null ? r1(s.avgSleepStress) : undefined,
    respiration_brpm: r1(s.averageRespirationValue),
    spo2_pct: s.averageSpO2Value,
    need_min: typeof s.sleepNeed === 'number' ? s.sleepNeed : s.sleepNeed?.actual ?? undefined,
  });
}

export function hrv(h) {
  return clean({
    date: h.calendarDate,
    last_night_avg_ms: h.lastNightAvg,
    last_night_5min_high_ms: h.lastNight5MinHigh,
    weekly_avg_ms: h.weeklyAvg,
    status: h.status?.toLowerCase?.(),
    baseline_low_ms: h.baseline?.balancedLow,
    baseline_high_ms: h.baseline?.balancedUpper,
    feedback: h.feedbackPhrase?.toLowerCase?.(),
  });
}

// Body Battery report for one day: values come as rows described by descriptors.
export function bodyBattery(b) {
  const keys = (b.bodyBatteryValueDescriptorDTOList || []).sort((x, y) => x.bodyBatteryValueDescriptorIndex - y.bodyBatteryValueDescriptorIndex).map(x => x.bodyBatteryValueDescriptorKey);
  const rows = (b.bodyBatteryValuesArray || []).map(r => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
  const levels = rows.map(r => Object.entries(r).filter(([k, v]) => typeof v === 'number' && !/time|stamp/i.test(k)).map(([, v]) => v)).filter(a => a.length);
  const all = levels.flat().filter(v => v >= 0 && v <= 100);
  const fb = b.bodyBatteryDynamicFeedbackEvent;
  return clean({
    date: b.date,
    charged: b.charged, drained: b.drained,
    start: levels[0]?.[0], end: levels.at(-1)?.at(-1),
    high: all.length ? Math.max(...all) : undefined, low: all.length ? Math.min(...all) : undefined,
    feedback: fb?.feedbackLongType?.toLowerCase?.() || fb?.feedbackShortType?.toLowerCase?.(),
    events: (b.bodyBatteryActivityEvent || []).map(e => clean({ type: e.eventType?.toLowerCase?.(), start: localTime(e.eventStartTimeGmt), min: e.durationInMilliseconds ? r1(e.durationInMilliseconds / 60000) : undefined, impact: e.bodyBatteryImpact })),
  });
}

export function weight(w) {
  return clean({
    date: w.calendarDate || (typeof w.date === 'string' ? w.date : undefined),
    time: localTime(w.timestampGMT) ? `${localTime(w.timestampGMT)} UTC` : undefined,
    weight_kg: kg(w.weight),
    bmi: r1(w.bmi),
    body_fat_pct: r1(w.bodyFat),
    body_water_pct: r1(w.bodyWater),
    muscle_kg: kg(w.muscleMass),
    bone_kg: kg(w.boneMass),
    visceral_fat: w.visceralFat,
    metabolic_age: w.metabolicAge,
  });
}

export function hrZones(list) {
  return (Array.isArray(list) ? list : []).map(z => clean({
    sport: z.sport?.toLowerCase?.() || 'default', method: z.trainingMethod?.toLowerCase?.(),
    max_hr_bpm: z.maxHeartRateUsed, resting_hr_bpm: z.restingHeartRateUsed, lthr_bpm: z.lactateThresholdHeartRateUsed,
    zone_floors_bpm: [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor].every(v => v != null) ? [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor] : undefined,
  }));
}

export function fitnessAge(f) {
  const x = Array.isArray(f) ? f[0] : f;
  return x ? clean({ fitness_age: r1(x.fitnessAge), achievable: r1(x.achievableFitnessAge), age: x.chronologicalAge, previous: r1(x.previousFitnessAge) }) : undefined;
}
