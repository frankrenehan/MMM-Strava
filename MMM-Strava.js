/* MMM-Strava.js
 * MagicMirror² module for displaying Strava running stats.
 * https://github.com/frankrenehan/MMM-Strava
 *
 * MIT Licensed.
 */

Module.register("MMM-Strava", {
  defaults: {
    clientId: "",
    clientSecret: "",
    updateInterval: 900000, // 15 minutes
    recentActivities: 3,
    showWeeklyStats: true,
    showYearToDate: true,
    showRecentRuns: true,
    showSufferScore: true,
    showHeartRate: true,
    showStreak: true,
    activityType: "Run", // "Run", "Ride", "All"
    units: "imperial", // "imperial" or "metric"
    maxWidth: "400px",
    animationSpeed: 1000,
  },

  // Store data from node_helper
  stravaData: null,
  errorMessage: null,

  getStyles: function () {
    return ["MMM-Strava.css"];
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.sendSocketNotification("STRAVA_INIT", this.config);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "STRAVA_DATA") {
      this.stravaData = payload;
      this.errorMessage = null;
      this.updateDom(this.config.animationSpeed);
    } else if (notification === "STRAVA_ERROR") {
      this.errorMessage = payload.message;
      this.updateDom(this.config.animationSpeed);
    }
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-strava";
    wrapper.style.maxWidth = this.config.maxWidth;

    // Error state
    if (this.errorMessage) {
      wrapper.innerHTML = `<div class="strava-error">${this.errorMessage}</div>`;
      return wrapper;
    }

    // Loading state
    if (!this.stravaData) {
      wrapper.innerHTML = '<div class="strava-loading dimmed light small">Loading Strava…</div>';
      return wrapper;
    }

    const data = this.stravaData;

    // Section 1: This Week
    if (this.config.showWeeklyStats && data.weeklyStats) {
      wrapper.appendChild(this.buildWeeklyStats(data.weeklyStats));
      wrapper.appendChild(this.buildDivider());
    }

    // Section 2: Recent Runs
    if (this.config.showRecentRuns && data.recentActivities && data.recentActivities.length > 0) {
      wrapper.appendChild(this.buildRecentRuns(data.recentActivities));
      wrapper.appendChild(this.buildDivider());
    }

    // Section 3: Year to Date
    if (this.config.showYearToDate && data.ytdStats) {
      wrapper.appendChild(this.buildYtdStats(data.ytdStats));
      wrapper.appendChild(this.buildDivider());
    }

    // Section 4: Last run + streak
    if (data.recentActivities && data.recentActivities.length > 0) {
      wrapper.appendChild(this.buildLastRunRow(data));
    }

    // Nudge (only shown when something needs attention)
    if (data.nudge) {
      const nudge = document.createElement("div");
      nudge.className = "strava-nudge";
      nudge.textContent = data.nudge;
      wrapper.appendChild(nudge);
    }

    // Attribution
    const attr = document.createElement("div");
    attr.className = "strava-attribution";
    attr.innerHTML = 'Powered by <span class="strava-brand">Strava</span>';
    wrapper.appendChild(attr);

    return wrapper;
  },

  // --- Section builders ---

  buildWeeklyStats: function (stats) {
    const section = document.createElement("div");
    section.className = "strava-week-stats";

    const dist = this.formatDistance(stats.distance);
    const pace = this.formatPace(stats.distance, stats.movingTime);
    const time = this.formatDuration(stats.movingTime);

    section.innerHTML = `
      <div class="week-primary">
        <div>
          <span class="week-primary-value">${dist.value}</span>
          <span class="week-primary-unit"> ${dist.unit}</span>
        </div>
        <div class="week-primary-label">This Week</div>
      </div>
      <div class="week-secondary">
        <div class="week-stat">
          <div class="week-stat-value">${stats.count} run${stats.count !== 1 ? "s" : ""}</div>
          <div class="week-stat-label">Activities</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-value">${time}</div>
          <div class="week-stat-label">Moving Time</div>
        </div>
        <div class="week-stat">
          <div class="week-stat-value">${pace}</div>
          <div class="week-stat-label">Avg Pace</div>
        </div>
      </div>
    `;
    return section;
  },

  buildRecentRuns: function (activities) {
    const section = document.createElement("div");

    const label = document.createElement("div");
    label.className = "strava-section-label";
    label.textContent = "Recent Runs";
    section.appendChild(label);

    const table = document.createElement("table");
    table.className = "strava-runs-table";

    // Header
    let headerHtml = "<thead><tr><th>Date</th><th>Dist</th><th>Pace</th><th>Time</th>";
    if (this.config.showHeartRate) headerHtml += "<th>HR</th>";
    if (this.config.showSufferScore) headerHtml += "<th>Effort</th>";
    headerHtml += "</tr></thead>";
    table.innerHTML = headerHtml;

    const tbody = document.createElement("tbody");
    const count = Math.min(activities.length, this.config.recentActivities);

    for (let i = 0; i < count; i++) {
      const act = activities[i];
      const dist = this.formatDistance(act.distance);
      const pace = this.formatPace(act.distance, act.moving_time);
      const time = this.formatDuration(act.moving_time);
      const date = this.formatRelativeDate(act.start_date_local);

      let row = `<tr>
        <td>${date}</td>
        <td>${dist.value} ${dist.unit}</td>
        <td class="pace-col">${pace}</td>
        <td>${time}</td>`;

      if (this.config.showHeartRate) {
        const hr = act.average_heartrate ? Math.round(act.average_heartrate) : "–";
        row += `<td>${hr}</td>`;
      }

      if (this.config.showSufferScore) {
        const score = act.suffer_score;
        if (score) {
          const cls = this.getSufferClass(score);
          row += `<td><span class="suffer-badge ${cls}">${score}</span></td>`;
        } else {
          row += "<td>–</td>";
        }
      }

      row += "</tr>";
      tbody.innerHTML += row;
    }

    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  },

  buildYtdStats: function (stats) {
    const section = document.createElement("div");

    const label = document.createElement("div");
    label.className = "strava-section-label";
    label.textContent = new Date().getFullYear() + " Year to Date";
    section.appendChild(label);

    const dist = this.formatDistance(stats.distance);
    const time = this.formatDuration(stats.movingTime);

    const row = document.createElement("div");
    row.className = "strava-ytd-row";
    row.innerHTML = `
      <div class="ytd-item">
        <div class="ytd-val">${dist.value} ${dist.unit}</div>
        <div class="ytd-label">Distance</div>
      </div>
      <div class="ytd-item">
        <div class="ytd-val">${stats.count}</div>
        <div class="ytd-label">Runs</div>
      </div>
      <div class="ytd-item">
        <div class="ytd-val">${time}</div>
        <div class="ytd-label">Time</div>
      </div>
    `;
    section.appendChild(row);
    return section;
  },

  buildLastRunRow: function (data) {
    const row = document.createElement("div");
    row.className = "strava-last-run-row";

    const lastAct = data.recentActivities[0];
    const dist = this.formatDistance(lastAct.distance);
    const pace = this.formatPace(lastAct.distance, lastAct.moving_time);
    const ago = this.formatTimeAgo(lastAct.start_date_local);

    let html = `<div class="last-run-text">Last run: <span>${dist.value} ${dist.unit} @ ${pace}</span> · ${ago}</div>`;

    if (this.config.showStreak && data.streak && data.streak > 0) {
      html += `<div class="strava-streak"><span class="streak-count">${data.streak} wk</span> streak</div>`;
    }

    row.innerHTML = html;
    return row;
  },

  buildDivider: function () {
    const hr = document.createElement("hr");
    hr.className = "strava-divider";
    return hr;
  },

  // --- Formatters ---

  formatDistance: function (meters) {
    if (this.config.units === "imperial") {
      const miles = meters / 1609.344;
      return { value: miles.toFixed(1), unit: "mi" };
    }
    const km = meters / 1000;
    return { value: km.toFixed(1), unit: "km" };
  },

  formatPace: function (meters, seconds) {
    if (!meters || meters === 0) return "–";
    let paceSeconds;
    if (this.config.units === "imperial") {
      const miles = meters / 1609.344;
      paceSeconds = seconds / miles;
    } else {
      const km = meters / 1000;
      paceSeconds = seconds / km;
    }
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.round(paceSeconds % 60);
    return `${mins}'${secs.toString().padStart(2, "0")}"`;
  },

  formatDuration: function (seconds) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${mins.toString().padStart(2, "0")}m`;
    }
    return `${mins}m`;
  },

  formatRelativeDate: function (isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) {
      return date.toLocaleDateString("en-US", { weekday: "short" });
    }
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  },

  formatTimeAgo: function (isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hr${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays === 1) return "yesterday";
    return `${diffDays} days ago`;
  },

  getSufferClass: function (score) {
    if (score >= 150) return "suffer-extreme";
    if (score >= 100) return "suffer-high";
    if (score >= 50) return "suffer-moderate";
    return "suffer-low";
  },
});
