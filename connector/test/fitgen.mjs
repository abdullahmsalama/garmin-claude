// Builds FIT files for tests (little-endian, normal headers, the fields our decoder reads).
const FIT_EPOCH = 631065600;
export function buildFit(msgs) {
  // msgs: [{ g, fields: [[num, base, size], ...], values: [v, ...] }]
  const parts = [], defsSeen = new Map();
  let local = 0;
  for (const m of msgs) {
    const key = `${m.g}|${m.fields.map(f => f.join(':')).join(',')}`;
    let l = defsSeen.get(key);
    if (l == null) {
      l = local++ % 16; defsSeen.set(key, l);
      const d = [0x40 | l, 0, 0, m.g & 0xff, m.g >> 8, m.fields.length];
      for (const [num, size, base] of m.fields) d.push(num, size, base);
      parts.push(Uint8Array.from(d));
    }
    const buf = new DataView(new ArrayBuffer(1 + m.fields.reduce((s, f) => s + f[1], 0)));
    buf.setUint8(0, l);
    let p = 1;
    m.fields.forEach(([, size, base], i) => {
      let v = m.values[i];
      const inv = { 1: 0xff, 2: 0xffff, 4: 0xffffffff }[size];
      if (v == null) v = base === 0x83 ? 0x7fff : base === 0x85 ? 0x7fffffff : inv;
      if (Array.isArray(v)) { v.forEach((x, k) => buf.setUint16(p + 2 * k, x, true)); }
      else if (size === 1) buf.setUint8(p, v); else if (size === 2) (base === 0x83 ? buf.setInt16(p, v, true) : buf.setUint16(p, v, true)); else buf.setUint32(p, v, true);
      p += size;
    });
    parts.push(new Uint8Array(buf.buffer));
  }
  const data = Buffer.concat(parts.map(x => Buffer.from(x)));
  const hdr = Buffer.alloc(14); hdr[0] = 14; hdr[1] = 0x20; hdr.writeUInt16LE(2100, 2); hdr.writeUInt32LE(data.length, 4); hdr.write('.FIT', 8);
  return new Uint8Array(Buffer.concat([hdr, data, Buffer.from([0, 0])]));
}
export const ts = ms => Math.round(ms / 1000) - FIT_EPOCH;
const U8 = 0x02, U16 = 0x84, U32 = 0x86, ENUM = 0x00;
const REC = [[253, 4, U32], [3, 1, U8], [4, 1, U8], [5, 4, U32], [73, 4, U32], [78, 4, U32], [39, 2, U16], [41, 2, U16], [83, 2, U16], [85, 2, U16], [84, 2, U16], [7, 2, U16], [53, 1, U8]];
// A run: `km` kilometres at `pace` s/km, HR climbing `drift` bpm from start to end, one 60 s pause at `pauseAt` km, one lap only.
export function run({ start = Date.UTC(2026, 9, 20, 4, 0), km = 10, pace = 300, hr0 = 140, drift = 10, pauseAt = 5, hill = false, sport = 1 } = {}) {
  const msgs = [], speed = 1000 / pace, total = km * pace;
  const t0 = start;
  msgs.push({ g: 21, fields: [[253, 4, U32], [0, 1, ENUM], [1, 1, ENUM]], values: [ts(t0), 0, 0] });
  let tms = t0, d = 0, paused = false;
  for (let s = 0; s <= total; s++) {
    if (!paused && pauseAt != null && d >= pauseAt * 1000) {
      paused = true; msgs.push({ g: 21, fields: [[253, 4, U32], [0, 1, ENUM], [1, 1, ENUM]], values: [ts(tms), 0, 1] });
      tms += 60000; msgs.push({ g: 21, fields: [[253, 4, U32], [0, 1, ENUM], [1, 1, ENUM]], values: [ts(tms), 0, 0] });
    }
    const frac = s / total, hr = Math.round(hr0 + drift * frac), alt = hill ? 100 + 50 * Math.sin(frac * Math.PI) : 100;
    msgs.push({ g: 20, fields: REC, values: [ts(tms), hr, 85, Math.round(d * 100), Math.round(speed * 1000), Math.round((alt + 500) * 5), 860, 2450, 780, 11500, 4980, 250, 0] });
    tms += 1000; d += speed;
  }
  msgs.push({ g: 19, fields: [[253, 4, U32], [2, 4, U32], [7, 4, U32], [8, 4, U32], [9, 4, U32], [15, 1, U8], [110, 4, U32]], values: [ts(tms), ts(t0), (tms - t0), total * 1000, Math.round(d * 100), hr0 + drift / 2, Math.round(speed * 1000)] });
  msgs.push({ g: 18, fields: [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [7, 4, U32], [8, 4, U32], [9, 4, U32], [16, 1, U8], [124, 4, U32]], values: [ts(tms), ts(t0), sport, (tms - t0), total * 1000, Math.round(d * 100), hr0 + drift / 2, Math.round(speed * 1000)] });
  return msgs;
}
export function strength({ start = Date.UTC(2026, 9, 21, 15, 0) } = {}) {
  const msgs = [], t0 = start;
  for (let i = 0; i < 6; i++) {
    const active = i % 2 === 0;
    msgs.push({ g: 225, fields: [[254, 4, U32], [0, 4, U32], [3, 2, U16], [4, 2, U16], [5, 1, U8], [6, 4, U32], [7, 4, U16], [8, 4, U16]], values: [ts(t0 + i * 90000), active ? 45000 : 60000, active ? 10 - i : null, active ? 60 * 16 + i * 8 : null, active ? 1 : 0, ts(t0 + i * 90000), active ? [0, 0xffff] : [0xffff, 0xffff], active ? [5, 0xffff] : [0xffff, 0xffff]] });
  }
  for (let s = 0; s < 540; s += 5) msgs.push({ g: 20, fields: [[253, 4, U32], [3, 1, U8]], values: [ts(t0 + s * 1000), 110 + (s % 90 < 45 ? 25 : 0)] });
  msgs.push({ g: 18, fields: [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [7, 4, U32], [8, 4, U32]], values: [ts(t0 + 540000), ts(t0), 10, 540000, 540000] });
  return msgs;
}
