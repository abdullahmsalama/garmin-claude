# Garmin data for Claude (skill)

Ask Claude about your own Garmin data (runs, sleep, HRV, stress, Body Battery, weight) from the Claude app on your phone. No server and no accounts: it's a Claude Skill that reads Garmin's official, read-only **Personal API** with your own key.

Not affiliated with Garmin or Anthropic. Not medical advice.

## Set it up (about 3 minutes, needs Claude Pro or Max)
1. **Garmin key:** Garmin Connect → Settings → Personal API Key → Create → copy it.
2. **Make your skill:** open the skill maker page (https://abdullahmsalama.github.io/garmin-claude/), paste the key, tap **Download my skill**.
   *Do it yourself instead:* download [my-garmin-data.zip](https://abdullahmsalama.github.io/garmin-claude/my-garmin-data.zip), unzip it, put your key in `my-garmin-data/key.txt`, zip the `my-garmin-data` folder again.
3. **In claude.ai** (browser): Settings → Capabilities:
   - turn on **Code execution and file creation**
   - turn on network access (called **Allow network egress**, **Network access** or **Domain allowlist** depending on your account), choose specific domains, and add only `personal.connectapi.garmin.com`
   - **Skills → Upload skill** → choose the zip
4. **Ask:** "Am I recovered enough to run hard today?"

## Why you can trust it
| Worry | Answer, and how to check it |
|---|---|
| The page steals my key | The page's Content-Security-Policy is `connect-src 'none'`: the browser blocks it from contacting any server. It builds the zip on your device. Check: turn on airplane mode and it still works; or view the source. |
| The code sends my data somewhere | You allow only `personal.connectapi.garmin.com` in Claude, so Claude's sandbox blocks every other address. The script is one readable Python file (`my-garmin-data/scripts/garmin.py`) with no dependencies. |
| It changes my Garmin account | Garmin's Personal API is read-only. The script only makes GET requests (plus the token exchange). |
| The download isn't the published code | `node build.mjs` rebuilds the zip and page from this repo and prints SHA-256 fingerprints; they match `dist/SHA256SUMS` byte for byte (fixed timestamps, sorted files). |
| I change my mind | Delete the key in Garmin Connect, and remove the skill in Claude. |

Your key sits inside the skill in your own Claude account; the script never prints it, and the skill tells Claude never to reveal it.

## Project layout
- `my-garmin-data/`: the skill (`SKILL.md`, `scripts/garmin.py`, `key.txt` placeholder)
- `maker/`: the skill maker page (`page.html`, `page.js`) and the tiny zip writer (`zip.js`) shared with the build
- `build.mjs`: builds `dist/` (zip, page, checksums). `VERSION` holds the version.

Test the script without Garmin: `GARMIN_BASE=http://localhost:8799 GARMIN_API_KEY=test-key-123 python3 my-garmin-data/scripts/garmin.py overview` against a mock server.

Prefer the free Claude plan or ChatGPT? Use your own connector instead: https://github.com/abdullahmsalama/garmin-claude/tree/main/connector
