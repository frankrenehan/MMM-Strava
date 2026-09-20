# MMM-Strava

A [MagicMirror²](https://magicmirror.builders/) module that displays your Strava running stats on your smart mirror.

![MMM-Strava Preview](screenshots/screenshot.png)

## Features

- **Weekly stats** – distance, run count, moving time, average pace
- **Recent runs** – compact table with distance, pace, duration, heart rate, and relative effort
- **Year to date** – total distance, runs, and time from Strava's built-in stats
- **Run streak** – consecutive weeks with at least one run
- **Training nudges** – alerts when mileage drops or you haven't run in a while
- **Auto-refreshing OAuth** – tokens refresh automatically, no re-authorization needed
- **Crash-safe token storage** – token writes are atomic, so a power cut can't corrupt your credentials
- **Stale-safe** – keeps showing last-known data during API hiccups

## Installation

1. Navigate to your MagicMirror modules directory:
   ```bash
   cd ~/MagicMirror/modules
   git clone https://github.com/frankrenehan/MMM-Strava.git
   cd MMM-Strava
   npm install
   ```

2. Create a Strava API application:
   - Go to https://www.strava.com/settings/api
   - **Application Name:** MMM-Strava
   - **Authorization Callback Domain:** localhost
   - Note your **Client ID** and **Client Secret**

3. Run the one-time OAuth setup:
   ```bash
   node setup.js --clientId=YOUR_CLIENT_ID --clientSecret=YOUR_CLIENT_SECRET
   ```
   Open the displayed URL in a browser, authorize the app, and tokens will be saved automatically.

   > **Port 5000 in use?** On macOS, AirPlay uses port 5000. Use `--port=5050` or any free port.

   > **Running headless on a Pi?** Run `setup.js` on your Mac, authorize in the browser, then `scp tokens.json` to the Pi.

   > **Storing tokens outside the module directory?** Set `tokenPath` in the module config to an absolute path and move `tokens.json` there. The module reads and refreshes tokens at that location.

   > **Note:** whether tokens live in the module directory or at a custom `tokenPath`, they are written atomically – see [Token storage](#token-storage) below.

4. Add the module to your `config/config.js`:
   ```javascript
   {
       module: "MMM-Strava",
       position: "bottom_left",
       header: "Strava",
       config: {
           clientId: "YOUR_CLIENT_ID",
           clientSecret: "YOUR_CLIENT_SECRET"
       }
   }
   ```

5. Restart MagicMirror.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `clientId` | `""` | Your Strava API Client ID |
| `clientSecret` | `""` | Your Strava API Client Secret |
| `tokenPath` | `""` | Optional **absolute** path to the token file (e.g. `"/home/pi/.config/mmm-strava/tokens.json"`). When empty, `tokens.json` in the module directory is used. A relative path is rejected and the module will not start. |
| `updateInterval` | `900000` | Refresh interval in ms (default: 15 min) |
| `recentActivities` | `3` | Number of recent runs to display |
| `showWeeklyStats` | `true` | Show "This Week" section |
| `showYearToDate` | `true` | Show YTD totals |
| `showRecentRuns` | `true` | Show recent activities table |
| `showSufferScore` | `true` | Show relative effort badges |
| `showHeartRate` | `true` | Show average HR column |
| `showStreak` | `true` | Show weekly run streak |
| `units` | `"metric"` | `"metric"` (km) or `"imperial"` (miles) |
| `maxWidth` | `"400px"` | Maximum module width |
| `animationSpeed` | `1000` | DOM update animation speed in ms |

## Token storage

Tokens are stored as JSON in `tokens.json` (module directory by default, or at `tokenPath` if you set one).

Both the initial `setup.js` write and every automatic refresh persist tokens **atomically**: the new contents are
written to a temporary file in the same directory, flushed to disk, and then renamed over the token file, with the
parent directory flushed afterwards. The token file is therefore only ever replaced by a complete copy — if the host
loses power or the process is killed mid-write, you are left with either the previous tokens or the new ones, never a
truncated or empty file. If the replacement can't be written, the existing token file is left untouched.

Token files are created with owner-only permissions (`0600`) on platforms that support them.

If the final directory flush fails on a filesystem that supports it, the module logs a warning: the tokens were
saved, but that last durability step didn't complete. Filesystems and platforms with no directory-flush
equivalent (Windows, some network mounts) are skipped silently.

## API Rate Limits

Strava allows 200 requests per 15 minutes and 2,000 per day. The module uses approximately 2–3 requests per refresh cycle, so at the default 15-minute interval you'll use roughly 192–288 requests per day – well within limits.

## Troubleshooting

**"Missing clientId or clientSecret in config.js"**
Add your Strava API credentials to the module config in `config/config.js`.

**"No tokens found. Run: node setup.js"**
You haven't completed the OAuth setup yet. Run `setup.js` as described above.

**"Token refresh failed. Re-run setup.js"**
Your refresh token has been revoked (e.g., you deauthorized the app on strava.com). Re-run `setup.js` to re-authorize.

**No heart rate or suffer score data**
These require a heart rate source (chest strap, watch, phone sensor) during the activity. Activities without HR data will show "–" in those columns.

## License

MIT – Frank Renehan

## Acknowledgements

- [MagicMirror²](https://magicmirror.builders/) – the open-source smart mirror platform
- [Strava API](https://developers.strava.com/) – activity data
