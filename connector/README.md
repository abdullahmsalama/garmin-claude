# Your own Garmin connector for Claude

Ask Claude about your Garmin data (runs, sleep, HRV, stress, Body Battery, weight) on your phone or the web, down to every km split and heartbeat of a workout. This is **your own copy**, running in **your own free Cloudflare account**. It reads Garmin's official, read-only **Personal API** with your own key, keeps a year of history, and updates itself every 30 minutes.

Works with Claude's free plan. Also works with ChatGPT's developer-mode connectors (paid plans, beta).
Not affiliated with Garmin, Anthropic or OpenAI. Not medical advice.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abdullahmsalama/garmin-claude/tree/main/connector)

## Set it up (about 10 minutes, all from your phone's browser)
1. **Garmin key:** Garmin Connect → Settings → Personal API Key → Create → copy it.
2. **Deploy:** tap the button above. Sign in to Cloudflare (free) and GitHub (free; Cloudflare keeps a copy of this code there for you).
   When it asks for **OWNER_PASSWORD**, type your own password: 12+ characters, a short sentence is great. Then **Deploy**.
3. **Connect Garmin:** open your new link (`https://garmin-claude-connector.<you>.workers.dev`), log in with your password, paste your Garmin key.
4. **Add to Claude:** in claude.ai (browser) → Settings → Connectors → Add custom connector → paste the link the page shows → Connect → type your password → Allow.
5. **Ask** in the Claude app: "Am I recovered enough to run hard today?"

### ChatGPT instead of Claude (beta)
Needs a paid ChatGPT plan; OpenAI moves these menus around, so look for "Connectors", "Apps" or "Developer mode".
1. At chatgpt.com (browser): Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**.
2. Apps & Connectors → **Create**: name **Garmin**, MCP server URL = the link your page shows, authentication **OAuth**, tick that you trust it, **Create**.
3. Your page opens: type your password → **Allow**.
4. New chat → ＋ → Developer mode → **Garmin**, and ask.

## What Claude can see (18 tools)
- **Overview:** `get_summary` (last 7 days vs the week before), `get_status` (is the key working, last sync).
- **By date:** `get_activities`, `get_daily`, `get_sleep`, `get_hrv`, `get_body_battery_stress`, `get_body`, `get_training`.
- **Inside one workout:**
  - `get_activity`: details and planned workout steps. Its `split_summaries` are Garmin's per-type totals (interval, run/walk), not km splits.
  - `get_splits`: per-km splits worked out from the recording (so a run saved as one lap still gets them), the watch's laps, multisport legs.
  - `get_activity_streams`: pace, HR, cadence, power, altitude, running dynamics and stamina over time.
  - `analyze_activity`: pauses, HR drift and decoupling, efficiency factor, negative split, best efforts inside it, HR-zone time.
  - `get_strength`: every set, rep and weight.
- **One whole day:** `get_day`: all-day HR curve, overnight HRV every 5 minutes, Body Battery curve, SpO2, detailed sleep.
- **Long-term:** `get_records` (best times, estimated race times), `get_trends` (week by week), `get_profile` (HR zones, LTHR and max HR history, fitness age).

Not in Garmin's Personal API, so not here: Training Readiness, Training Status, VO2 max history, FTP, Garmin's own race predictions.

Times are in **your time zone**, read from your Garmin settings on the first sync.

**Already set up an older version?** The easiest update: tap the Deploy button again to make a fresh copy, paste your Garmin key on its page, then in Claude remove the old connector, add the new link, and start a new chat (Claude only loads the tool list when you connect). Delete the old Worker in Cloudflare afterwards. Workout files are analysed in the background, newest first, so the detailed tools answer instantly for recent workouts; older ones take a few seconds the first time.

## Why it's private
- It runs in your Cloudflare account. Nobody else, including the author of this code, can reach your data or key.
- Your Garmin key and Garmin's access token are stored **encrypted** (AES-GCM) in your own database.
- Claude can only connect after you type your password and tap Allow. Wrong passwords are rate-limited.
- Read-only: Garmin's Personal API can't change your account or send anything to your watch.
- Undo anytime: delete the key in Garmin Connect, remove the connector in Claude, delete the Worker in Cloudflare.

## Good to know
- **Changing your password** (Cloudflare → your Worker → Settings → Variables and Secrets → OWNER_PASSWORD) logs everything out and asks for your Garmin key again, because the key is encrypted with it.
- **Garmin key expired?** Make a new one and paste it under "Replace Garmin key" on your page.
- Free Cloudflare limits are far above what one person uses.

## For developers
`npm install`, then `npm run dev` (put `OWNER_PASSWORD` in `.dev.vars`). Tables are created on first request (`src/schema.js`). `npm test` runs the tests (Node 22.5+; a fake Garmin server and FIT files built in the test).
Code: `src/index.js` (pages, login, OAuth), `src/mcp.js` + `src/tools.js` (everyday tools) + `src/tools2.js` (detailed tools), `src/deep.js` (workout files and day detail, cached in D1), `src/store.js` (sync, storage, time zone), `src/garmin/` (API client, data clean-up, FIT decoder and workout analysis), `src/crypto.js` (encryption).
