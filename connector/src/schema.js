// Creates the tables on first use, so a fresh deploy works without running migrations
// (Cloudflare's Deploy button only runs `wrangler deploy`). Safe to run again: everything is IF NOT EXISTS.
const SQL = [
  // Every item pulled from Garmin, filed by type. data = compact JSON.
  `CREATE TABLE IF NOT EXISTS summaries (user_id TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, day TEXT, start INTEGER, ref TEXT, data TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY (user_id, type, id))`,
  `CREATE INDEX IF NOT EXISTS summaries_day ON summaries (user_id, type, day)`,
  // A short log for the status page (no health values in it).
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)`,
  // Failed logins, to slow down password guessing.
  `CREATE TABLE IF NOT EXISTS login_fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS login_fails_ts ON login_fails (ts)`,
  // Encrypted secrets: the Garmin key (id 'apikey') and the 24-hour access token (id 'owner').
  `CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, enc TEXT NOT NULL, exp INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  // History loading, a few requests every 5 minutes.
  `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', tries INTEGER NOT NULL DEFAULT 0, msg TEXT, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id)`,
  // Small facts: last sync time, last error, etc.
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT, updated INTEGER NOT NULL)`,
];

let ready = null;
export function ensureSchema(env) {
  ready ??= env.DB.batch(SQL.map(s => env.DB.prepare(s))).catch(e => { ready = null; throw e; });
  return ready;
}
