// Skill maker: puts your key into key.txt and zips the skill, all inside this page.
// FILES is filled in by build.mjs with the skill's files (base64), straight from the skill/ folder.
const FILES = /*FILES*/[];
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const $ = id => document.getElementById(id);

$('show').onclick = () => { const k = $('key'); k.type = k.type === 'password' ? 'text' : 'password'; $('show').textContent = k.type === 'password' ? 'Show' : 'Hide'; };
$('copyDomain').onclick = async () => {
  try { await navigator.clipboard.writeText('personal.connectapi.garmin.com'); $('copyDomain').textContent = 'Copied'; } catch { $('copyDomain').textContent = 'Select it'; }
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
  const a = document.createElement('a');
  a.href = url; a.download = 'my-garmin-data.zip';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  $('key').value = '';
  msg.className = 'msg ok';
  msg.textContent = '✓ Saved my-garmin-data.zip (check your Downloads / Files). Now do step 3.';
};
