// Builds everything people download, from the files in this repo (no other inputs, so anyone can
// rebuild it and get the same fingerprints):
//   dist/my-garmin-data.zip  the skill with an empty key.txt (for the "do it yourself" route)
//   dist/index.html          the skill maker page (skill files + zip code inside, no network)
//   dist/SHA256SUMS          fingerprints of both
// Run: node build.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SKILL = path.join(ROOT, 'my-garmin-data');
const DIST = path.join(ROOT, 'dist');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const sha256 = (data, enc = 'hex') => crypto.createHash('sha256').update(data).digest(enc);

// Skill files, sorted so the zip is always the same. key.txt always ships as the placeholder.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith('.') || e.name === '__pycache__') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SKILL).sort().map(p => {
  const rel = 'my-garmin-data/' + path.relative(SKILL, p).split(path.sep).join('/');
  const data = rel.endsWith('/key.txt') ? Buffer.from('PASTE-YOUR-GARMIN-PERSONAL-API-KEY-HERE\n') : fs.readFileSync(p);
  return { path: rel, data: new Uint8Array(data) };
});
if (!files.some(f => f.path === 'my-garmin-data/SKILL.md')) throw new Error('SKILL.md missing');

const zipSrc = fs.readFileSync(path.join(ROOT, 'maker', 'zip.js'), 'utf8');
const makeZip = new Function(`${zipSrc}\nreturn makeZip;`)();
const zip = makeZip(files);

const pageJs = fs.readFileSync(path.join(ROOT, 'maker', 'page.js'), 'utf8')
  .replace('/*FILES*/[]', JSON.stringify(files.map(f => ({ path: f.path, b64: Buffer.from(f.data).toString('base64') }))));
const script = `\n${zipSrc}\n${pageJs}\n`;
const html = fs.readFileSync(path.join(ROOT, 'maker', 'page.html'), 'utf8')
  .replace('{{SCRIPT_HASH}}', `sha256-${sha256(script, 'base64')}`) // only this exact script may run
  .replace('{{SCRIPT}}', () => script)
  .replaceAll('{{VERSION}}', VERSION)
  .replace('{{ZIP_SHA}}', sha256(zip).slice(0, 16));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
fs.writeFileSync(path.join(DIST, 'my-garmin-data.zip'), zip);
fs.writeFileSync(path.join(DIST, 'index.html'), html);
const sums = `${sha256(zip)}  my-garmin-data.zip\n${sha256(html)}  index.html\n`;
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), sums);
console.log(`v${VERSION}: ${files.length} files\n${sums}`);
