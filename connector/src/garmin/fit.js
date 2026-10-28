// Garmin activity files: unzip (Garmin sends a .zip) and decode the FIT messages we use.
// No libraries. Field numbers, types and scales from the FIT SDK profile (Profile.xlsx).
// Missing values (FIT "invalid") come back as null. Times are FIT seconds -> epoch ms (UTC).

const FIT_EPOCH = 631065600000; // 1989-12-31T00:00:00Z

// ---------- zip ----------
// Returns the bytes of the first .fit file inside a zip (or the input if it's already a FIT file).
export async function fitFromDownload(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 12 && String.fromCharCode(b[8], b[9], b[10], b[11]) === '.FIT') return b;
  if (!(b[0] === 0x50 && b[1] === 0x4b)) throw new Error('activity file is not a zip or FIT file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('broken zip');
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0 && p < b.length; n--) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    if (/\.fit$/i.test(name)) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = b.slice(start, start + csize);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`zip method ${method} not supported`);
      return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error('no .fit file in the zip');
}

// ---------- profile (only what we use) ----------
// [name, scale, offset]. Types come from the file itself.
const PROFILE = {
  18: { name: 'session', f: { 253: ['timestamp'], 2: ['start_time'], 5: ['sport'], 6: ['sub_sport'], 7: ['total_elapsed_time', 1000], 8: ['total_timer_time', 1000], 9: ['total_distance', 100], 11: ['total_calories'], 14: ['avg_speed', 1000], 15: ['max_speed', 1000], 16: ['avg_heart_rate'], 17: ['max_heart_rate'], 18: ['avg_cadence'], 19: ['max_cadence'], 20: ['avg_power'], 21: ['max_power'], 22: ['total_ascent'], 23: ['total_descent'], 25: ['first_lap_index'], 26: ['num_laps'], 124: ['enhanced_avg_speed', 1000], 125: ['enhanced_max_speed', 1000] } },
  19: { name: 'lap', f: { 253: ['timestamp'], 254: ['message_index'], 2: ['start_time'], 7: ['total_elapsed_time', 1000], 8: ['total_timer_time', 1000], 9: ['total_distance', 100], 11: ['total_calories'], 13: ['avg_speed', 1000], 14: ['max_speed', 1000], 15: ['avg_heart_rate'], 16: ['max_heart_rate'], 17: ['avg_cadence'], 18: ['max_cadence'], 19: ['avg_power'], 20: ['max_power'], 21: ['total_ascent'], 22: ['total_descent'], 24: ['lap_trigger'], 25: ['sport'], 77: ['avg_vertical_oscillation', 10], 79: ['avg_stance_time', 10], 80: ['avg_fractional_cadence', 128], 110: ['enhanced_avg_speed', 1000], 111: ['enhanced_max_speed', 1000] } },
  20: { name: 'record', f: { 253: ['timestamp'], 2: ['altitude', 5, 500], 3: ['heart_rate'], 4: ['cadence'], 5: ['distance', 100], 6: ['speed', 1000], 7: ['power'], 13: ['temperature'], 39: ['vertical_oscillation', 10], 40: ['stance_time_percent', 100], 41: ['stance_time', 10], 53: ['fractional_cadence', 128], 73: ['enhanced_speed', 1000], 78: ['enhanced_altitude', 5, 500], 83: ['vertical_ratio', 100], 84: ['stance_time_balance', 100], 85: ['step_length', 10], 90: ['performance_condition'], 108: ['enhanced_respiration_rate', 100] } },
  21: { name: 'event', f: { 253: ['timestamp'], 0: ['event'], 1: ['event_type'] } },
  225: { name: 'set', f: { 254: ['timestamp'], 0: ['duration', 1000], 3: ['repetitions'], 4: ['weight', 16], 5: ['set_type'], 6: ['start_time'], 7: ['category'], 8: ['category_subtype'], 10: ['message_index'] } },
};
const ARRAY_OK = { set: new Set(['category', 'category_subtype']) };

// Base types: [byte size, reader, invalid value]
const BASE = {
  0x00: [1, 'u8', 0xff], 0x01: [1, 's8', 0x7f], 0x02: [1, 'u8', 0xff], 0x83: [2, 's16', 0x7fff], 0x84: [2, 'u16', 0xffff], 0x85: [4, 's32', 0x7fffffff], 0x86: [4, 'u32', 0xffffffff],
  0x07: [1, 'str', null], 0x88: [4, 'f32', null], 0x89: [8, 'f64', null], 0x0a: [1, 'u8', 0], 0x8b: [2, 'u16', 0], 0x8c: [4, 'u32', 0], 0x0d: [1, 'u8', 0xff],
  0x8e: [8, 'skip', null], 0x8f: [8, 'skip', null], 0x90: [8, 'skip', null],
};
function read(dv, p, kind, little) {
  switch (kind) {
    case 'u8': return dv.getUint8(p); case 's8': return dv.getInt8(p);
    case 'u16': return dv.getUint16(p, little); case 's16': return dv.getInt16(p, little);
    case 'u32': return dv.getUint32(p, little); case 's32': return dv.getInt32(p, little);
    case 'f32': return dv.getFloat32(p, little); case 'f64': return dv.getFloat64(p, little);
    default: return null;
  }
}

// Decodes a FIT file into { sessions, laps, records, events, sets } (plain objects, scaled units, nulls for missing).
export function decodeFit(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hs = u8[0], size = dv.getUint32(4, true);
  if (String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== '.FIT') throw new Error('not a FIT file');
  const out = { session: [], lap: [], record: [], event: [], set: [] };
  const defs = [];
  let p = hs, lastTs = 0;
  const end = Math.min(hs + size, u8.length);
  while (p < end) {
    const h = u8[p++];
    let def, tsOverride = null;
    if (h & 0x80) {
      def = defs[(h >> 5) & 3];
      const off = h & 0x1f;
      tsOverride = (lastTs & ~0x1f) + off + (off < (lastTs & 0x1f) ? 0x20 : 0);
      lastTs = tsOverride;
    } else if (h & 0x40) {
      const little = u8[p + 1] === 0, g = little ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2, false), nf = u8[p + 4];
      p += 5;
      const prof = PROFILE[g], fields = [];
      let size = 0;
      for (let i = 0; i < nf; i++, p += 3) {
        const num = u8[p], fsize = u8[p + 1], base = BASE[u8[p + 2]] || [1, 'skip', null];
        const meta = prof?.f[num];
        fields.push({ off: size, num, size: fsize, base, name: meta?.[0], scale: meta?.[1] || 1, offset: meta?.[2] || 0 });
        size += fsize;
      }
      if (h & 0x20) { const nd = u8[p++]; for (let i = 0; i < nd; i++, p += 3) size += u8[p + 1]; }
      defs[h & 0x0f] = { g, prof, fields: fields.filter(f => f.name), size, little };
      continue;
    } else def = defs[h & 0x0f];
    if (!def) throw new Error('FIT data before its definition');
    if (def.prof) {
      const m = {};
      for (const f of def.fields) {
        const [bsize, kind, invalid] = f.base;
        if (kind === 'skip' || kind === 'str') continue;
        const n = Math.floor(f.size / bsize);
        const one = q => { const v = read(dv, q, kind, def.little); return v === invalid || (kind[0] === 'f' && !isFinite(v)) ? null : (f.scale !== 1 || f.offset ? v / f.scale - f.offset : v); };
        if (n > 1 && ARRAY_OK[def.prof.name]?.has(f.name)) { const arr = []; for (let i = 0; i < n; i++) { const v = one(p + f.off + i * bsize); if (v != null) arr.push(v); } m[f.name] = arr.length ? arr : null; }
        else m[f.name] = one(p + f.off);
      }
      if (m.timestamp != null && def.prof.name !== 'set') lastTs = m.timestamp;
      if (tsOverride != null) m.timestamp = tsOverride;
      for (const k of ['timestamp', 'start_time']) if (m[k] != null) m[k] = FIT_EPOCH + m[k] * 1000;
      out[def.prof.name].push(m);
    }
    p += def.size;
  }
  return { sessions: out.session, laps: out.lap, records: out.record, events: out.event, sets: out.set };
}

// FIT enums we turn into words.
export const SPORT = { 0: 'generic', 1: 'running', 2: 'cycling', 3: 'transition', 4: 'fitness_equipment', 5: 'swimming', 6: 'basketball', 10: 'training', 11: 'walking', 13: 'e_biking', 15: 'rowing', 17: 'hiking', 21: 'e_biking', 22: 'water_sports', 30: 'inline_skating', 31: 'rock_climbing', 37: 'stand_up_paddleboarding', 41: 'kayaking', 43: 'snowshoeing', 53: 'diving', 62: 'hiit', 64: 'racket', 76: 'water_tubing', 80: 'mixed_martial_arts', 82: 'motorcycling' };
export const EXERCISE = ['bench_press', 'calf_raise', 'cardio', 'carry', 'chop', 'core', 'crunch', 'curl', 'deadlift', 'flye', 'hip_raise', 'hip_stability', 'hip_swing', 'hyperextension', 'lateral_raise', 'leg_curl', 'leg_raise', 'lunge', 'olympic_lift', 'plank', 'plyo', 'pull_up', 'push_up', 'row', 'shoulder_press', 'shoulder_stability', 'shrug', 'sit_up', 'squat', 'total_body', 'triceps_extension', 'warm_up', 'run'];
