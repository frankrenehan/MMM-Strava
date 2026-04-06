#!/usr/bin/env node

/* setup.js
 * One-time OAuth2 setup for MMM-Strava.
 * Starts a local Express server, opens the Strava authorization URL,
 * catches the callback, exchanges the code for tokens, and saves them.
 *
 * Usage:
 *   node setup.js --clientId=YOUR_ID --clientSecret=YOUR_SECRET
 *
 * Or set environment variables:
 *   STRAVA_CLIENT_ID=YOUR_ID STRAVA_CLIENT_SECRET=YOUR_SECRET node setup.js
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");

// Parse args
const args = {};
process.argv.slice(2).forEach((arg) => {
  const [key, val] = arg.replace(/^--/, "").split("=");
  args[key] = val;
});

const CLIENT_ID = args.clientId || process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = args.clientSecret || process.env.STRAVA_CLIENT_SECRET;
const PORT = args.port || 5000;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;
const TOKEN_FILE = path.resolve(__dirname, "tokens.json");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌ Missing credentials.\n");
  console.error("Usage:");
  console.error("  node setup.js --clientId=YOUR_ID --clientSecret=YOUR_SECRET\n");
  console.error("Or set environment variables:");
  console.error("  STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET\n");
  process.exit(1);
}

const app = express();

app.get("/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    res.status(400).send("No authorization code received. Please try again.");
    return;
  }

  console.log("\n✅ Authorization code received. Exchanging for tokens...");

  try {
    const tokens = await exchangeCode(code);

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log("✅ Tokens saved to tokens.json");
    console.log(`   Access token expires at: ${new Date(tokens.expires_at * 1000).toISOString()}`);
    console.log("   Refresh token will auto-renew.\n");
    console.log("🎉 Setup complete! Add your config to config.js and restart MagicMirror.\n");

    res.send(`
      <html>
        <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px;">
          <h1 style="color: #fc4c02;">✅ MMM-Strava Authorized</h1>
          <p>Tokens saved. You can close this window.</p>
        </body>
      </html>
    `);

    // Shut down after a short delay
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error("❌ Token exchange failed:", err.message);
    res.status(500).send("Token exchange failed: " + err.message);
  }
});

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: "authorization_code",
    });

    const options = {
      hostname: "www.strava.com",
      port: 443,
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(JSON.stringify(json.errors)));
          } else {
            resolve({
              access_token: json.access_token,
              refresh_token: json.refresh_token,
              expires_at: json.expires_at,
              athlete_id: json.athlete ? json.athlete.id : null,
            });
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// Start server
app.listen(PORT, () => {
  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}` +
    `&response_type=code` +
    `&scope=read,activity:read_all` +
    `&approval_prompt=force`;

  console.log("\n🏃 MMM-Strava OAuth Setup");
  console.log("─".repeat(50));
  console.log(`\nCallback server listening on port ${PORT}`);
  console.log("\nOpen this URL in your browser to authorize:\n");
  console.log(`  ${authUrl}\n`);
  console.log("Waiting for authorization...\n");
});
