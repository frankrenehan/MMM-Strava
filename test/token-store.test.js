/* Tests for atomic token persistence (lib/token-store.js).
 * Run with: npm test  (node --test)
 *
 * No real OAuth credentials are used anywhere in this file.
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeFileAtomicSync, saveTokensSync, TOKEN_FILE_MODE } = require("../lib/token-store.js");

const POSIX = process.platform !== "win32";

const FAKE_TOKENS = {
  access_token: "fake-access",
  refresh_token: "fake-refresh",
  expires_at: 1700000000,
  athlete_id: 1234,
};

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmm-strava-atomic-"));
}

// Anything in the destination directory that is not the token file itself.
function strayFiles(dir, tokenFile) {
  return fs.readdirSync(dir).filter((name) => name !== path.basename(tokenFile));
}

function withTmpDir(fn) {
  const dir = makeTmpDir();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.afterEach(() => {
  mock.restoreAll();
});

test("saveTokensSync writes valid JSON with the expected contents", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const raw = fs.readFileSync(tokenFile, "utf8");
    assert.deepEqual(JSON.parse(raw), FAKE_TOKENS);
    // Same pretty-printed shape the module has always written.
    assert.equal(raw, JSON.stringify(FAKE_TOKENS, null, 2));
  });
});

test("saved token file is owner-only where the platform reports modes", (t) => {
  if (!POSIX) return t.skip("file modes not checkable on this platform");

  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    assert.equal(fs.statSync(tokenFile).mode & 0o777, TOKEN_FILE_MODE);
  });
});

test("replacing a world-readable token file does not weaken permissions", (t) => {
  if (!POSIX) return t.skip("file modes not checkable on this platform");

  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    fs.writeFileSync(tokenFile, "{}", { mode: 0o644 });
    fs.chmodSync(tokenFile, 0o644);

    saveTokensSync(tokenFile, FAKE_TOKENS);

    assert.equal(fs.statSync(tokenFile).mode & 0o777, TOKEN_FILE_MODE);
  });
});

test("no temporary file is left behind after a successful save", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    saveTokensSync(tokenFile, { ...FAKE_TOKENS, access_token: "second" });

    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("a successful atomic save replaces the previous file contents", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const rotated = { ...FAKE_TOKENS, access_token: "rotated", refresh_token: "rotated-refresh" };
    saveTokensSync(tokenFile, rotated);

    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), rotated);
  });
});

test("failure while writing the replacement leaves the existing file intact", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile, "utf8");

    mock.method(fs, "writeFileSync", () => {
      throw new Error("simulated ENOSPC");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), /simulated ENOSPC/);
    mock.restoreAll();

    assert.equal(fs.readFileSync(tokenFile, "utf8"), before);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("failure while fsyncing the replacement leaves the existing file intact", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile, "utf8");

    mock.method(fs, "fsyncSync", () => {
      throw new Error("simulated EIO");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), /simulated EIO/);
    mock.restoreAll();

    assert.equal(fs.readFileSync(tokenFile, "utf8"), before);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("rename failure removes the temp file, keeps the destination and rethrows", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile, "utf8");

    mock.method(fs, "renameSync", () => {
      throw new Error("simulated EXDEV");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), /simulated EXDEV/);
    mock.restoreAll();

    assert.equal(fs.readFileSync(tokenFile, "utf8"), before);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

// Make the parent-directory fsync (the second fsync of a save) fail with the
// given error, leaving the temp-file fsync alone.
function failDirectoryFsync(error) {
  const realFsync = fs.fsyncSync;
  const state = { calls: 0 };
  mock.method(fs, "fsyncSync", (fd) => {
    state.calls += 1;
    if (state.calls > 1) throw error;
    return realFsync(fd);
  });
  return state;
}

function captureWarnings() {
  const warnings = [];
  mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  return warnings;
}

function errorWithCode(code) {
  const err = new Error(`simulated ${code}`);
  err.code = code;
  return err;
}

test("directory fsync failure still completes the save and closes the descriptor", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const fsync = failDirectoryFsync(errorWithCode("EIO"));

    const closed = [];
    const realClose = fs.closeSync;
    mock.method(fs, "closeSync", (fd) => {
      closed.push(fd);
      return realClose(fd);
    });
    captureWarnings();

    const rotated = { ...FAKE_TOKENS, access_token: "rotated-despite-dirsync" };
    assert.doesNotThrow(() => saveTokensSync(tokenFile, rotated));
    mock.restoreAll();

    assert.equal(fsync.calls, 2, "directory fsync was attempted");
    assert.equal(closed.length, 2, "temp file and directory descriptors were both closed");
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), rotated);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("a genuine directory fsync failure warns that durability was not achieved", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    failDirectoryFsync(errorWithCode("EIO"));
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[MMM-Strava\]/);
    assert.match(warnings[0], /EIO/);
    assert.match(warnings[0], /power loss/);
    // The save itself still succeeded.
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
  });
});

test("an actionable directory error such as EACCES is reported, not swallowed", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    failDirectoryFsync(errorWithCode("EACCES"));
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EACCES/);
  });
});

test("a filesystem without directory fsync support warns nothing", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    withTmpDir((dir) => {
      const tokenFile = path.join(dir, "tokens.json");
      failDirectoryFsync(errorWithCode(code));
      const warnings = captureWarnings();

      assert.doesNotThrow(() => saveTokensSync(tokenFile, FAKE_TOKENS));
      mock.restoreAll();

      assert.deepEqual(warnings, [], `${code} should be treated as unsupported, not as a failure`);
      // The save itself still succeeded.
      assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
      assert.deepEqual(strayFiles(dir, tokenFile), []);
    });
  }
});

test("a successful save warns nothing", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    assert.deepEqual(warnings, []);
  });
});

test("on Windows the directory fsync is skipped deliberately and silently", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const opened = [];
    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      opened.push(String(target));
      return realOpen(target, ...rest);
    });
    const warnings = captureWarnings();

    try {
      saveTokensSync(tokenFile, FAKE_TOKENS);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      mock.restoreAll();
    }

    assert.equal(opened.length, 1, "only the temp file is opened; the directory is not");
    assert.deepEqual(warnings, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("writeFileAtomicSync creates a destination that does not exist yet", () => {
  withTmpDir((dir) => {
    const dest = path.join(dir, "brand-new.json");
    writeFileAtomicSync(dest, "hello");

    assert.equal(fs.readFileSync(dest, "utf8"), "hello");
    assert.deepEqual(strayFiles(dir, dest), []);
  });
});

test("writeFileAtomicSync propagates errors when the directory is missing", () => {
  withTmpDir((dir) => {
    const dest = path.join(dir, "nope", "tokens.json");
    assert.throws(() => writeFileAtomicSync(dest, "{}"), { code: "ENOENT" });
  });
});

test("the temporary file is created in the destination directory", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "tokens.json");
    const opened = [];
    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      opened.push(String(target));
      return realOpen(target, ...rest);
    });

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    // First open is the temp file; it must be a sibling of the destination so
    // the rename stays atomic (no cross-filesystem move).
    assert.equal(path.dirname(opened[0]), dir);
    assert.notEqual(opened[0], tokenFile);
  });
});
