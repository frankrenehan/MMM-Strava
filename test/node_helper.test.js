/* Tests for tokenPath handling and token persistence in node_helper.js.
 * Run with: npm test  (node --test)
 *
 * No real OAuth credentials are used anywhere in this file.
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");

// Resolve MagicMirror's "node_helper" alias to a local stub.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "node_helper") {
    return path.join(__dirname, "stubs", "node_helper.js");
  }
  return origResolveFilename.call(this, request, ...rest);
};

const MODULE_DIR = path.resolve(__dirname, "..");
const DEFAULT_TOKEN_FILE = path.resolve(MODULE_DIR, "tokens.json");
const Helper = require("../node_helper.js");

const FAKE_TOKENS = {
  access_token: "fake-access",
  refresh_token: "fake-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

// Build a helper with network/scheduling side effects stubbed out.
function makeHelper() {
  const helper = new Helper();
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    helper.sent.push({ notification, payload });
  };
  helper.fetchData = mock.fn(async () => {});
  helper.scheduleUpdates = mock.fn(() => {});
  helper.start();
  return helper;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmm-strava-test-"));
}

const BASE_CONFIG = { clientId: "id", clientSecret: "secret", updateInterval: 900000 };

test.beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

test.afterEach(() => {
  mock.restoreAll();
});

test("default: no tokenPath keeps tokens.json in the module directory", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn(() => {
    helper.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived("STRAVA_INIT", { ...BASE_CONFIG });

  assert.equal(helper.tokenFile, DEFAULT_TOKEN_FILE);
  assert.equal(helper.loadTokens.mock.callCount(), 1);
  assert.equal(helper.fetchData.mock.callCount(), 1);
  assert.equal(helper.scheduleUpdates.mock.callCount(), 1);
  assert.deepEqual(helper.sent, []);
});

test("default: empty-string tokenPath (module default) behaves like unset", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn(() => {
    helper.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived("STRAVA_INIT", { ...BASE_CONFIG, tokenPath: "" });

  assert.equal(helper.tokenFile, DEFAULT_TOKEN_FILE);
  assert.equal(helper.fetchData.mock.callCount(), 1);
  assert.deepEqual(helper.sent, []);
});

test("valid absolute tokenPath is used to load and save tokens", () => {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "strava-tokens.json");
  fs.writeFileSync(tokenPath, JSON.stringify(FAKE_TOKENS));

  try {
    const helper = makeHelper();
    helper.socketNotificationReceived("STRAVA_INIT", { ...BASE_CONFIG, tokenPath });

    assert.equal(helper.tokenFile, tokenPath);
    assert.equal(helper.tokens.access_token, FAKE_TOKENS.access_token);
    assert.equal(helper.fetchData.mock.callCount(), 1);
    assert.deepEqual(helper.sent, []);

    // Refreshed tokens are written back to the same custom path
    helper.tokens.access_token = "rotated";
    helper.saveTokens();
    const onDisk = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    assert.equal(onDisk.access_token, "rotated");
    assert.ok(!fs.existsSync(path.join(tmp, "tokens.json")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("invalid relative tokenPath emits STRAVA_ERROR and aborts init", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn();

  helper.socketNotificationReceived("STRAVA_INIT", {
    ...BASE_CONFIG,
    tokenPath: "relative/tokens.json",
  });

  assert.equal(helper.sent.length, 1);
  assert.equal(helper.sent[0].notification, "STRAVA_ERROR");
  assert.match(helper.sent[0].payload.message, /tokenPath must be an absolute path/);
  assert.equal(helper.tokenFile, DEFAULT_TOKEN_FILE);
  assert.equal(helper.loadTokens.mock.callCount(), 0);
  assert.equal(helper.fetchData.mock.callCount(), 0);
  assert.equal(helper.scheduleUpdates.mock.callCount(), 0);
});

test("non-string tokenPath emits STRAVA_ERROR and aborts init", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn();

  helper.socketNotificationReceived("STRAVA_INIT", { ...BASE_CONFIG, tokenPath: 42 });

  assert.equal(helper.sent.length, 1);
  assert.equal(helper.sent[0].notification, "STRAVA_ERROR");
  assert.equal(helper.loadTokens.mock.callCount(), 0);
  assert.equal(helper.fetchData.mock.callCount(), 0);
});

// --- Atomic token persistence via the helper ---

function strayFiles(dir, tokenFile) {
  return fs.readdirSync(dir).filter((name) => name !== path.basename(tokenFile));
}

test("saveTokens round-trips through loadTokens for a module-local tokens.json", () => {
  const tmp = makeTmpDir();
  try {
    const helper = makeHelper();
    // Same default file name the module uses, in a throwaway directory.
    helper.tokenFile = path.join(tmp, "tokens.json");
    helper.tokens = { ...FAKE_TOKENS };
    helper.saveTokens();

    assert.deepEqual(JSON.parse(fs.readFileSync(helper.tokenFile, "utf8")), FAKE_TOKENS);
    assert.deepEqual(strayFiles(tmp, helper.tokenFile), []);

    const reader = makeHelper();
    reader.tokenFile = helper.tokenFile;
    reader.loadTokens();
    assert.deepEqual(reader.tokens, FAKE_TOKENS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("saveTokens writes an owner-only file and leaves no temp file behind", () => {
  const tmp = makeTmpDir();
  try {
    const helper = makeHelper();
    helper.tokenFile = path.join(tmp, "strava-tokens.json");
    helper.tokens = { ...FAKE_TOKENS };
    helper.saveTokens();

    assert.deepEqual(strayFiles(tmp, helper.tokenFile), []);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(helper.tokenFile).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("saveTokens failure logs and leaves the previous token file intact", () => {
  const tmp = makeTmpDir();
  try {
    const helper = makeHelper();
    helper.tokenFile = path.join(tmp, "tokens.json");
    helper.tokens = { ...FAKE_TOKENS };
    helper.saveTokens();
    const before = fs.readFileSync(helper.tokenFile, "utf8");

    const errors = [];
    mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    mock.method(fs, "renameSync", () => {
      throw new Error("simulated rename failure");
    });

    helper.tokens = { ...FAKE_TOKENS, access_token: "never-written" };
    // Existing behaviour: the error is logged, not thrown.
    assert.doesNotThrow(() => helper.saveTokens());
    mock.restoreAll();

    assert.equal(fs.readFileSync(helper.tokenFile, "utf8"), before);
    assert.deepEqual(strayFiles(tmp, helper.tokenFile), []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Error saving tokens/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- setup.js persistence ---

test("setup.js persists initial tokens through the shared atomic writer", () => {
  const source = fs.readFileSync(path.join(MODULE_DIR, "setup.js"), "utf8");

  assert.match(source, /require\("\.\/lib\/token-store\.js"\)/);
  assert.match(source, /saveTokensSync\(TOKEN_FILE, tokens\)/);
  // No direct, non-atomic write to the token file remains.
  assert.doesNotMatch(source, /writeFileSync/);
});
