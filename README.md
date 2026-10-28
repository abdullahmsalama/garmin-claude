# Ask Claude about your Garmin data

Your runs (down to every km: splits, heart-rate drift, pauses, best efforts), strength sets, sleep, HRV, stress, Body Battery and weight, answered by Claude, on your phone or the web. Uses Garmin's official, read-only **Personal API** with your own key. Free and open source.

**Start here: https://abdullahmsalama.github.io/garmin-claude/**

## Pick one
| | Option 1: Claude Skill | Option 2: your own connector |
|---|---|---|
| Setup | ~3 min, nothing to sign up for | ~10 min, free Cloudflare + GitHub accounts |
| Claude plan | Pro or Max | Free works |
| ChatGPT | No | Paid plans (developer mode, beta) |
| Inside each workout | Splits, streams, analysis, strength sets (from the activity file, live) | The same, worked out once and kept |
| Records and trends | From the period you ask about | From your stored year |
| History | Fetched live when you ask | A full year, kept up to date every 30 min |
| Where it runs | Inside your Claude account | In your own Cloudflare account |
| Guide | [skill/](skill/) | [connector/](connector/) |

## Privacy, in short
- Your Garmin key stays with you: in your own Claude account (option 1) or encrypted in your own Cloudflare account (option 2). Nobody else, including the author, can see it or your data.
- Read-only: nothing can change your Garmin account or send anything to your watch.
- Everything here is the code that runs. The guide page and skill zip are built from this repo by GitHub Actions ([workflow](.github/workflows/publish.yml)).

Not affiliated with or endorsed by Garmin, Anthropic or OpenAI. Not medical advice. MIT licence.
