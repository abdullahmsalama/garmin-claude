# Your own Garmin connector for Claude

Ask Claude about your Garmin data (runs, sleep, HRV, stress, Body Battery, weight) on your phone or the web. This is **your own copy**, running in **your own free Cloudflare account**. It reads Garmin's official, read-only **Personal API** with your own key, keeps a year of history, and updates itself every 30 minutes.

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
`npm install`, then `npm run dev` (put `OWNER_PASSWORD` in `.dev.vars`). Tables are created on first request (`src/schema.js`).
Code: `src/index.js` (pages, login, OAuth), `src/mcp.js` + `src/tools.js` (the 10 tools), `src/store.js` (sync and storage), `src/garmin/` (API client and data clean-up), `src/crypto.js` (encryption).
