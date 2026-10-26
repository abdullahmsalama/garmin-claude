// Skill maker: puts your key into key.txt and zips the skill, all inside this page.
// FILES is filled in by build.mjs with the skill's files (base64), straight from the skill folder.
const FILES = /*FILES*/[];
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const $ = id => document.getElementById(id);
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- option 1 / option 2 toggle (also #skill / #connector links) ----------
function pick(n, push) {
  $('switch').dataset.on = String(n);
  [1, 2].forEach(i => { $('t' + i).setAttribute('aria-selected', String(i === n)); $('p' + i).hidden = i !== n; });
  if (push) history.replaceState(null, '', n === 2 ? '#connector' : '#skill');
}
$('t1').onclick = () => pick(1, true);
$('t2').onclick = () => pick(2, true);
const fromHash = () => { if (/connector|option-?2/.test(location.hash)) { pick(2); $('setup').scrollIntoView(); } else if (/skill|option-?1/.test(location.hash)) pick(1); };
fromHash();
addEventListener('hashchange', fromHash);

// ---------- chat demo (sample numbers) ----------
const DEMOS = [
  { icon: '🔋', q: 'Am I recovered enough to run hard today?', tools: ['overview', 'hrv', 'sleep'],
    a: 'Yes, go for it. Your HRV was [64 ms], inside your normal range (55–70). You slept [7 h 42] with a score of [84], and Body Battery started the day at [86]. This week\'s load is [1.1×] your 4-week average, so a tempo session fits. Keep the warm-up long.' },
  { icon: '😴', q: 'How did my sleep this week compare to last week?', tools: ['sleep'],
    a: 'Better. You averaged [7 h 18] a night, [26 min] more than last week, with [1 h 31] of deep sleep. Your best night was Thursday (score [88]). Tuesday was short at [5 h 50], after your late run.' },
  { icon: '🏃', q: 'Build next week\'s plan from my last 4 weeks.', tools: ['activities', 'training'],
    a: 'You\'ve run [32–38 km] a week with one long run of [16–18 km]. Next week: Mon rest, Tue [8 km] easy, Wed [3×10 min] tempo at [4:35/km], Thu [6 km] recovery, Sat long run [19 km], Sun [5 km] shake-out. That\'s [40 km], a safe +8%.' },
  { icon: '❤️', q: 'Is my resting heart rate trending up?', tools: ['daily'],
    a: 'Slightly. It\'s [49 bpm] this week vs [47] over the last month. Small rises like this often follow hard training or short sleep. If it stays above [50] for a few days, take an easy day.' },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let demoRun = 0;
async function play(i) {
  const run = ++demoRun, d = DEMOS[i];
  document.querySelectorAll('.ask').forEach((b, j) => b.classList.toggle('on', j === i));
  const q = $('q'), a = $('a'), t = $('tools');
  q.textContent = ''; a.innerHTML = '<span class="caret"></span>'; t.innerHTML = '';
  if (calm) { q.textContent = d.q; t.innerHTML = d.tools.map(x => `<span class="mini">⚙︎ ${x}</span>`).join(''); a.innerHTML = fmt(d.a); return; }
  for (const ch of d.q) { if (run !== demoRun) return; q.textContent += ch; await sleep(22); }
  await sleep(250);
  for (const x of d.tools) { if (run !== demoRun) return; t.insertAdjacentHTML('beforeend', `<span class="mini">⚙︎ ${x}</span>`); await sleep(320); }
  const words = d.a.split(' ');
  for (let w = 1; w <= words.length; w++) { if (run !== demoRun) return; a.innerHTML = fmt(words.slice(0, w).join(' ')) + '<span class="caret"></span>'; await sleep(38); }
  a.innerHTML = fmt(d.a);
}
// [numbers] in the answers are highlighted
const fmt = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\[([^\]]+)\]/g, '<span class="n">$1</span>');
$('asks').innerHTML = DEMOS.map((d, i) => `<button class="ask" type="button" data-i="${i}"><span>${d.icon}</span><span>${d.q}</span></button>`).join('');
document.querySelectorAll('.ask').forEach(b => b.onclick = () => play(+b.dataset.i));
// Start the demo when it scrolls into view (or straight away on wide screens).
const io = 'IntersectionObserver' in window ? new IntersectionObserver(e => { if (e[0].isIntersecting) { io.disconnect(); play(0); } }, { threshold: .35 }) : null;
if (io) io.observe($('demo')); else play(0);

// ---------- option 1: make the skill ----------
$('show').onclick = () => { const k = $('key'); k.type = k.type === 'password' ? 'text' : 'password'; $('show').textContent = k.type === 'password' ? 'Show' : 'Hide'; };
$('copyDomain').onclick = async () => {
  try { await navigator.clipboard.writeText('personal.connectapi.garmin.com'); $('copyDomain').textContent = 'Copied ✓'; } catch { $('copyDomain').textContent = 'Select it'; }
  setTimeout(() => { $('copyDomain').textContent = 'Copy'; }, 2000);
};
$('make').onclick = () => {
  const key = $('key').value.trim(), msg = $('msg');
  msg.className = 'msg';
  if (!key) { msg.className = 'msg err'; msg.textContent = 'Paste your Garmin key first.'; return; }
  if (/\s/.test(key) || key.length < 16 || key.length > 4000) { msg.className = 'msg err'; msg.textContent = "That doesn't look like a Garmin key. Copy it again from Garmin Connect."; return; }
  const enc = new TextEncoder();
  const files = FILES.map(f => ({ path: f.path, data: f.path.endsWith('/key.txt') ? enc.encode(key + '\n') : fromB64(f.b64) }));
  const url = URL.createObjectURL(new Blob([makeZip(files)], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'my-garmin-data.zip';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  $('key').value = '';
  msg.className = 'msg ok';
  msg.textContent = '✓ Saved my-garmin-data.zip (check Downloads / Files). Now step 3.';
};
