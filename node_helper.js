/* node_helper.js
 * Backend for MMM-Strava. Handles Strava OAuth token management
 * and API calls via strava-v3.
 */

const NodeHelper = require("node_helper");
const strava = require("strava-v3");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
  tokenFile: null,
  tokens: null,
  config: null,
  timer: null,

  start: function () {
    console.log("[MMM-Strava] Node helper started.");
    this.tokenFile = path.resolve(__dirname, "tokens.json");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "STRAVA_INIT") {
      this.config = payload;
      this.loadTokens();

      if (!this.tokens) {
        this.sendSocketNotification("STRAVA_ERROR", {
          message: "No tokens found. Run: node setup.js",
        });
        return;
      }

      // Fetch immediately, then on interval
      this.fetchData();
      this.scheduleUpdates();
    }
  },

  // --- Token management ---

  loadTokens: function () {
    try {
      if (fs.existsSync(this.tokenFile)) {
        const raw = fs.readFileSync(this.tokenFile, "utf8");
        this.tokens = JSON.parse(raw);
        console.log("[MMM-Strava] Tokens loaded.");
      }
    } catch (err) {
      console.error("[MMM-Strava] Error loading tokens:", err.message);
      this.tokens = null;
    }
  },

  saveTokens: function () {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2));
    } catch (err) {
      console.error("[MMM-Strava] Error saving tokens:", err.message);
    }
  },

  refreshTokenIfNeeded: async function () {
    if (!this.tokens) return false;

    const now = Math.floor(Date.now() / 1000);
    // Refresh if token expires within 5 minutes
    if (this.tokens.expires_at && this.tokens.expires_at > now + 300) {
      return true; // Token still valid
    }

    console.log("[MMM-Strava] Refreshing access token...");

    try {
      const result = await strava.oauth.refreshToken(this.tokens.refresh_token);

      this.tokens.access_token = result.access_token;
      this.tokens.refresh_token = result.refresh_token;
      this.tokens.expires_at = result.expires_at;
      this.saveTokens();

      console.log("[MMM-Strava] Token refreshed successfully.");
      return true;
    } catch (err) {
      console.error("[MMM-Strava] Token refresh failed:", err.message);
      this.sendSocketNotification("STRAVA_ERROR", {
        message: "Token refresh failed. Re-run setup.js",
      });
      return false;
    }
  },

  // --- Data fetching ---

  fetchData: async function () {
    // Configure strava client
    strava.client({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const valid = await this.refreshTokenIfNeeded();
    if (!valid) return;

    const accessToken = this.tokens.access_token;

    try {
      // Fetch in parallel: athlete stats + recent activities
      const [athleteResp, activitiesResp] = await Promise.all([
        this.getAthleteStats(accessToken),
        this.getRecentActivities(accessToken),
      ]);

      // Process data
      const payload = this.processData(athleteResp, activitiesResp);
      this.sendSocketNotification("STRAVA_DATA", payload);
    } catch (err) {
      console.error("[MMM-Strava] Fetch error:", err.message);
      this.sendSocketNotification("STRAVA_ERROR", {
        message: "Failed to fetch Strava data",
      });
    }
  },

  getAthleteStats: function (accessToken) {
    return new Promise((resolve, reject) => {
      // First get the athlete ID
      strava.athlete.get({ access_token: accessToken }, (err, athlete) => {
        if (err) return reject(err);

        strava.athletes.stats(
          { id: athlete.id, access_token: accessToken },
          (err2, stats) => {
            if (err2) return reject(err2);
            resolve({ athlete, stats });
          }
        );
      });
    });
  },

  getRecentActivities: function (accessToken) {
    return new Promise((resolve, reject) => {
      // Fetch last 20 activities (we'll filter client-side)
      strava.athlete.listActivities(
        {
          access_token: accessToken,
          per_page: 20,
          page: 1,
        },
        (err, activities) => {
          if (err) return reject(err);
          resolve(activities || []);
        }
      );
    });
  },

  // --- Data processing ---

  processData: function (athleteResp, activities) {
    const { stats } = athleteResp;
    const activityType = this.config.activityType || "Run";

    // Filter by activity type
    let filtered = activities;
    if (activityType !== "All") {
      filtered = activities.filter((a) => a.type === activityType);
    }

    // Weekly stats: filter activities from start of current week (Monday)
    const weeklyStats = this.calcWeeklyStats(filtered);

    // YTD stats from Strava's built-in stats
    const ytdStats = this.extractYtdStats(stats, activityType);

    // Calculate streak (consecutive weeks with at least one run)
    const streak = this.calcWeekStreak(filtered);

    // Training nudge – only set when something needs attention
    const nudge = this.checkTrainingNudge(filtered);

    return {
      weeklyStats,
      ytdStats,
      recentActivities: filtered,
      streak,
      nudge,
    };
  },

  calcWeeklyStats: function (activities) {
    // Get Monday 00:00 of the current week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);

    const thisWeek = activities.filter((a) => new Date(a.start_date_local) >= monday);

    const totalDistance = thisWeek.reduce((sum, a) => sum + (a.distance || 0), 0);
    const totalMovingTime = thisWeek.reduce((sum, a) => sum + (a.moving_time || 0), 0);

    return {
      distance: totalDistance,
      movingTime: totalMovingTime,
      count: thisWeek.length,
    };
  },

  extractYtdStats: function (stats, activityType) {
    let ytd;
    if (activityType === "Ride") {
      ytd = stats.ytd_ride_totals;
    } else if (activityType === "Swim") {
      ytd = stats.ytd_swim_totals;
    } else {
      ytd = stats.ytd_run_totals;
    }

    if (!ytd) {
      return { distance: 0, movingTime: 0, count: 0 };
    }

    return {
      distance: ytd.distance || 0,
      movingTime: ytd.moving_time || 0,
      count: ytd.count || 0,
    };
  },

  calcWeekStreak: function (activities) {
    if (!activities || activities.length === 0) return 0;

    // Get start of current week (Monday)
    const now = new Date();
    const getWeekStart = (date) => {
      const d = new Date(date);
      const dayOfWeek = d.getDay();
      const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      d.setDate(d.getDate() + offset);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };

    // Build a set of week-start timestamps that have activities
    const weeksWithRuns = new Set();
    activities.forEach((a) => {
      weeksWithRuns.add(getWeekStart(a.start_date_local));
    });

    // Count consecutive weeks backwards from current week
    let streak = 0;
    let weekStart = getWeekStart(now);

    while (weeksWithRuns.has(weekStart)) {
      streak++;
      // Go to previous Monday
      const prev = new Date(weekStart);
      prev.setDate(prev.getDate() - 7);
      weekStart = prev.getTime();
    }

    return streak;
  },

  // --- Training nudge ---
  // Pure algorithmic check. No LLM needed – just math on dates and distances.
  // Returns null when everything's fine; a string when something needs attention.

  checkTrainingNudge: function (activities) {
    if (!activities || activities.length === 0) {
      return "No runs on record – time to lace up";
    }

    const now = new Date();
    const nudges = [];

    // 1. Days since last run
    const lastRunDate = new Date(activities[0].start_date_local);
    const daysSinceLastRun = Math.floor((now - lastRunDate) / 86400000);

    if (daysSinceLastRun >= 10) {
      nudges.push(`No runs in ${daysSinceLastRun} days`);
    } else if (daysSinceLastRun >= 7) {
      nudges.push(`${daysSinceLastRun} days since your last run`);
    }

    // 2. Weekly mileage trending down (current + last week below 4-week rolling avg)
    const weekBuckets = this.getWeeklyDistances(activities, 5); // 5 weeks back
    if (weekBuckets.length >= 4) {
      const rollingAvg = weekBuckets.slice(1, 5).reduce((s, d) => s + d, 0) / Math.min(weekBuckets.length - 1, 4);

      if (rollingAvg > 0) {
        const currentWeek = weekBuckets[0];
        const lastWeek = weekBuckets.length > 1 ? weekBuckets[1] : 0;

        // Both current and last week below 70% of rolling average
        if (currentWeek < rollingAvg * 0.7 && lastWeek < rollingAvg * 0.7) {
          nudges.push("Mileage trending down – 2 weeks below your average");
        }
      }
    }

    // 3. Frequency drop: averaging 3+/week over last month but this week is 0–1
    if (weekBuckets.length >= 4) {
      const recentWeekCounts = this.getWeeklyRunCounts(activities, 5);
      const avgFreq = recentWeekCounts.slice(1, 5).reduce((s, c) => s + c, 0) / Math.min(recentWeekCounts.length - 1, 4);

      if (avgFreq >= 2.5 && recentWeekCounts[0] <= 1) {
        // Only fire this from Wednesday onwards – give yourself time to run early in the week
        if (now.getDay() >= 3 || now.getDay() === 0) {
          nudges.push("Only " + recentWeekCounts[0] + " run" + (recentWeekCounts[0] !== 1 ? "s" : "") + " this week – you usually do " + Math.round(avgFreq));
        }
      }
    }

    // Return the highest-priority nudge (first one), or null if all clear
    return nudges.length > 0 ? nudges[0] : null;
  },

  getWeeklyDistances: function (activities, numWeeks) {
    const now = new Date();
    const buckets = new Array(numWeeks).fill(0);

    activities.forEach((a) => {
      const actDate = new Date(a.start_date_local);
      const weeksAgo = this.weeksAgo(actDate, now);
      if (weeksAgo >= 0 && weeksAgo < numWeeks) {
        buckets[weeksAgo] += a.distance || 0;
      }
    });

    return buckets;
  },

  getWeeklyRunCounts: function (activities, numWeeks) {
    const now = new Date();
    const buckets = new Array(numWeeks).fill(0);

    activities.forEach((a) => {
      const actDate = new Date(a.start_date_local);
      const weeksAgo = this.weeksAgo(actDate, now);
      if (weeksAgo >= 0 && weeksAgo < numWeeks) {
        buckets[weeksAgo]++;
      }
    });

    return buckets;
  },

  // Returns how many weeks ago a date falls relative to now (0 = current week)
  weeksAgo: function (date, now) {
    const getMonday = (d) => {
      const result = new Date(d);
      const day = result.getDay();
      const offset = day === 0 ? -6 : 1 - day;
      result.setDate(result.getDate() + offset);
      result.setHours(0, 0, 0, 0);
      return result;
    };

    const nowMonday = getMonday(now).getTime();
    const dateMonday = getMonday(date).getTime();
    return Math.floor((nowMonday - dateMonday) / (7 * 86400000));
  },

  // --- Scheduling ---

  scheduleUpdates: function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.fetchData();
    }, this.config.updateInterval);
  },
});
