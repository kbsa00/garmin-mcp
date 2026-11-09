# garmin-mcp

Your own Garmin Connect data in Claude. This is a personal, self-hosted **remote MCP server** on **Cloudflare Workers** (free plan) that you add to [claude.ai](https://claude.ai) as a custom connector.

It covers:
- **Recovery:** sleep, HRV, resting heart rate, Body Battery and stress.
- **Training:** activities, laps, VO2 max, Fitness Age and training load.
- **Computed metrics:** readiness, ACWR and recovery after hard sessions.

Typical use: ask Claude *"How did I sleep, and how hard should I train today?"*, or schedule a daily morning brief.

- Single user: you deploy your own instance with your own Garmin key, and nobody else can use it.
- Uses the official **[Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/)**. Personal, non-commercial use only.
- Not affiliated with or endorsed by Garmin or Anthropic.

## What you need
- **A Garmin Connect account and a Personal API key.** Create the key at <https://connect.garmin.com/app/settings/personalApiToken>. It is shown only once; you choose an expiry of 30, 90 or 180 days or 1 year.
- **A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.**
- **Node.js 22+ and npm.**
- **A Claude plan that supports custom connectors.**

## Setup (about 10 minutes)
```sh
git clone https://github.com/<you>/garmin-mcp.git
cd garmin-mcp
npm install
cp .env.example .env           # then put your key in .env: GARMIN_API_KEY=...
npx wrangler login             # log in to YOUR Cloudflare account
npm run setup                  # creates everything and deploys (see below)
node scripts/backfill.mjs      # loads all your Garmin history into the database
```

`npm run setup` (`scripts/setup-instance.mjs`) is safe to run again; steps that are done are skipped. It:
1. pins `wrangler.jsonc` to your Cloudflare account id, so it can never deploy into another account;
2. creates the KV namespaces and the D1 database and writes their ids into `wrangler.jsonc`;
3. applies the D1 migrations;
4. uploads your Garmin key as a Worker secret, and creates a login passphrase in `CONNECTOR_LOGIN.txt` (local only, gitignored);
5. registers a workers.dev subdomain if your account has none, sets the connector URL, and deploys.

At the end it prints your connector URL, e.g. `https://garmin-mcp.<subdomain>.workers.dev/mcp`.

**Add it to Claude:**
1. Go to **Settings → Connectors → Add custom connector**.
2. Paste the URL and leave the OAuth Client ID and Secret empty.
3. Click **Connect** and enter the passphrase from `CONNECTOR_LOGIN.txt`.

> After `npm run setup`, `wrangler.jsonc` contains *your* account and resource ids. They are not secrets, but if you publish a fork, keep your setup-modified `wrangler.jsonc` out of it.

## Tools
| tool | what it does | source |
|---|---|---|
| `get_recovery(date?)` | One day: sleep (score, duration, stages, times), HRV (overnight average, status, baseline range), resting HR, Body Battery (at wake, high/low), stress, plus a `missing` list | Garmin |
| `get_recovery_trend(days ≤ 60)` | Daily rows plus 7- and 28-day averages of HRV and resting HR | Garmin + averages |
| `get_activities(from, to, type?)` | Activities with distance, time, pace, HR, Training Effect, training load, cadence, power, stride and VO2 max, plus totals per type | Garmin |
| `get_activity_detail(activity_id)` | Per-lap data from the activity's FIT file: pace, HR, cadence (steps/min), step length, power, running dynamics | Garmin (FIT) |
| `get_vo2max_trend(days ≤ 365)` | The watch's VO2 max estimate per activity, read from the FIT file | Garmin (FIT) |
| `get_fitness_age(date?)` | Garmin Fitness Age with its components and targets | Garmin |
| `get_training_load(days ≤ 90)` | Daily load, acute (7d) and chronic (28d) load, ACWR and a status label | computed |
| `get_readiness(date?)` | Deterministic 0–100 readiness score with components and a one-line explanation | computed |
| `get_recovery_after(date)` | Nights until HRV and resting HR were back in your baseline band after that day's activity | computed |
| `health_check()` | Verifies the Garmin token exchange. Returns no health data | – |

### Garmin data vs. computed metrics
Every result **starts with a `provenance` block**:
- **`garmin_provided`:** fields supplied by Garmin, passed through unchanged except for unit conversion.
- **`computed_by_connector`:** fields this connector calculates itself.

The server's MCP instructions tell Claude to say which is which, and never to present a computed metric (such as readiness) as a Garmin feature. Tool descriptions are labelled `[Garmin data]` or `[Connector's own calculation; not Garmin …]`.

### Not available from the Garmin Personal API
- Training Readiness and Training Status. `get_readiness` and `get_training_load` are this connector's own metrics instead, and they will differ from the watch.
- Race predictions.
- Lactate threshold.
- Workout or course push: the API is read-only.
- VO2 max as an API field. It is read from the FIT file instead; see [Formulas](#formulas).

See [ENDPOINTS.md](ENDPOINTS.md) for the endpoints used and their response shapes.

## How it works
```
claude.ai ──OAuth 2.1 (DCR + PKCE)──▶ Cloudflare Worker
                                      ├─ workers-oauth-provider: /.well-known/*, /register, /token, /authorize (passphrase login)
                                      ├─ /mcp (token required) → MCP server (Streamable HTTP)
                                      │     ├─ recovery service   D1 first (completed days), Garmin API for the rest
                                      │     └─ activity service   activities, FIT laps, load / readiness / recovery
                                      └─ cron 05:30 local → nightly sync of the last 3 days into D1
Garmin client → personal.connectapi.garmin.com (token cached in KV; 401 → refresh + retry; 429 → backoff)
FIT parsing → @garmin/fitsdk (unneeded messages are stripped first to stay within the free plan's CPU limit)
```

| storage | content |
|---|---|
| Worker secrets | `GARMIN_API_KEY`, `LOGIN_PASSPHRASE_HASH` (PBKDF2) |
| D1 | `daily_recovery`, `activities` (incl. VO2 max), `activity_laps`, `sync_state` |
| KV `OAUTH_KV` | OAuth clients, grants, tokens |
| KV `APP_KV` | Cached Garmin access token, login rate limits, login state |

### Security
- **Protected endpoint:** only `/mcp` serves data, and it requires a valid OAuth access token.
- **Login:** a passphrase checked against a PBKDF2 hash. The login form has a one-time CSRF state bound to a `__Host-` cookie.
- **Brute-force protection:** 5 failed logins per IP per 15 minutes, and 20 per hour in total.
- **Secrets:** they live only in your local `.env` and in Worker secrets. The scripts pipe them in and never print them.
- **Logs:** they contain counts only, never health data.

## Formulas
- **Training load / ACWR:**
  - Daily load = the sum of Garmin's per-activity `activityTrainingLoad`.
  - Acute load = the 7-day mean; chronic load = the 28-day mean; ACWR = acute / chronic.
  - Status: < 0.8 `detraining`, < 1.0 `maintaining`, ≤ 1.3 `productive`, above that `overreaching_risk`. It is `insufficient_data` with less than 28 days of history or very low load.
- **Readiness (0–100):**

  | component | weight | score |
  |---|---|---|
  | HRV | 30% | `70 + 15·z` vs your 60-day baseline |
  | Resting HR | 20% | `70 + 15·z`, inverted (lower is better) |
  | Sleep score | 20% | Garmin sleep score |
  | Sleep duration | 15% | `100 · min(1, h/8)` |
  | Load | 15% | ACWR through yesterday: ≤ 1.0 → 100, 1.3 → 70, 1.5 → 30, ≥ 2.0 → 0 |

  - Missing parts are dropped and the weights renormalized. The same inputs always give the same score.
- **Recovery after a hard day:**
  - **Bands:** HRV uses Garmin's "balanced" range; resting HR uses your 60-day mean ± 1 sd.
  - **Counting:** only the first night after the activity decides whether a value left its band (day 2 if day 1 has no data). If it did, the count runs to the first night back in band.
- **Body Battery at wake:** the 15-minute reading closest to the end of sleep. Garmin's Body Battery report covers roughly the last 4 months.
- **VO2 max:**
  - **Source:** the watch stores its estimate in each outdoor activity's FIT file, in the undocumented message 140, field 7: VO2 max = raw × 3.5 / 65536.
  - **Validation:** the format is community-documented and was validated against a watch, which shows the value rounded to an integer.
  - **Treadmill:** treadmill activities don't update it, so they are stored as null.

## Configuration
- **Time zone:** dates are interpreted in `Europe/Oslo`. To change it:
  - set `TIMEZONE` in `src/dates.ts`;
  - adjust the two UTC crons in `wrangler.jsonc` so that one of them hits 05:30 local time in summer and winter;
  - adjust the hour check in `isOsloSyncHour` (`src/sync/sync.ts`).
- **Worker name / URL:** change `name` in `wrangler.jsonc` before running `npm run setup`.
- **Strength training:** strength sessions are listed and count towards training load, but set, rep and weight details are not parsed.

## Maintenance
| task | command |
|---|---|
| Redeploy | `npm test && npm run type-check && npx wrangler deploy` |
| New migrations | `npx wrangler d1 migrations apply <database_name> --remote` |
| New Garmin key (when it expires) | put it in `.env`, then `npm run update-garmin-key` |
| New login passphrase | `npm run rotate-passphrase` |
| Reload all history | `node scripts/backfill.mjs` (idempotent) |
| Local development | `npx wrangler d1 migrations apply <database_name> --local`, then `node scripts/new-passphrase.mjs --no-deploy --dev /tmp/dev-hash.env --login-file /tmp/dev-login.txt`, then `npm run dev -- --hash-file /tmp/dev-hash.env` |

**Tests:** `npm test` runs the unit and integration tests. They use mocked Garmin responses, FIT fixtures and D1 on `node:sqlite`. `npm run type-check` checks the types.

## Contributing
Issues and pull requests are welcome. Please:
- run `npm test` and `npm run type-check`;
- never commit `.env`, `CONNECTOR_LOGIN.txt` or real health data (test fixtures must be synthetic).

## License
[MIT](LICENSE). Use of the Garmin Connect Personal API is subject to Garmin's own terms (personal, non-commercial use).
