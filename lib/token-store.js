/* lib/token-store.js
 * Crash-resistant persistence for the OAuth token file.
 *
 * A plain fs.writeFileSync() truncates the destination before writing, so a
 * power cut mid-write can leave an empty or half-written tokens.json behind.
 * These helpers write a temporary file in the same directory, fsync it, then
 * rename it over the destination, so the token file is only ever replaced by
 * a complete copy.
 *
 * Built-in modules only – no external dependencies.
 */

const fs = require("fs");
const path = require("path");

// Owner read/write only: the file holds OAuth credentials.
const TOKEN_FILE_MODE = 0o600;

// Errors that mean "this filesystem does not implement a directory fsync",
// rather than "the flush was attempted and failed". Some network and virtual
// filesystems report these, and there is nothing the user could act on, so
// they stay silent. Anything else (EIO, ENOSPC, EACCES, ...) is a real
// failure of the durability step and is worth surfacing.
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

// Windows has no directory-flush equivalent at all; skip it deliberately
// instead of opening a directory just to fail and warn about it every time.
function directorySyncSupported() {
  return process.platform !== "win32";
}

let tmpCounter = 0;

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    // Best effort: the temp file may never have been created.
  }
}

function safeClose(fd) {
  try {
    fs.closeSync(fd);
  } catch (err) {
    // Best effort: used on cleanup paths where the real error is already known.
  }
}

// Temp name lives beside the destination so the final rename stays atomic
// (a rename across filesystems is not).
function tempPathFor(destPath) {
  tmpCounter += 1;
  const base = `.${path.basename(destPath)}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
  return path.join(path.dirname(destPath), base);
}

/**
 * Atomically replace destPath with data.
 *
 * On any failure before the rename the destination is left exactly as it was
 * and the temporary file is removed; the error is then re-thrown.
 *
 * @param {string} destPath Absolute or relative path of the file to replace.
 * @param {string|Buffer} data Complete contents to write.
 * @param {{mode?: number}} [options] File mode for the replacement (default 0600).
 */
function writeFileAtomicSync(destPath, data, options = {}) {
  const mode = options.mode === undefined ? TOKEN_FILE_MODE : options.mode;
  const dir = path.dirname(destPath);
  const tmpPath = tempPathFor(destPath);

  // Create the temp file with restrictive permissions, write it, flush it to
  // disk, then close it. The destination is untouched throughout this stage.
  let fd;
  try {
    fd = fs.openSync(tmpPath, "wx", mode);
    // openSync applies the umask; force the exact mode where the platform
    // supports it so the credentials never land world-readable.
    try {
      fs.fchmodSync(fd, mode);
    } catch (err) {
      // Not supported on every platform (notably Windows) – the open mode stands.
    }
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) safeClose(fd);
    safeUnlink(tmpPath);
    throw err;
  }

  // Atomic swap: a reader sees either the old file or the new one, never both
  // halves of a partial write.
  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    safeUnlink(tmpPath);
    throw err;
  }

  // fsync the parent directory so the renamed entry itself survives a power
  // cut. The replacement is already in place and the data is already flushed,
  // so this must never fail the write – but it is the last durability step
  // this helper exists to provide, so a genuine failure is worth a warning.
  if (!directorySyncSupported()) return;

  let dirFd;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED.has(err.code)) {
      console.warn(
        `[MMM-Strava] Token file replaced, but flushing its directory failed (${err.code || err.message}). ` +
          "The new tokens may not survive a sudden power loss."
      );
    }
  } finally {
    if (dirFd !== undefined) safeClose(dirFd);
  }
}

/**
 * Serialize and atomically persist an OAuth token object.
 *
 * @param {string} tokenFile Path of the token file.
 * @param {object} tokens Token object to store.
 */
function saveTokensSync(tokenFile, tokens) {
  writeFileAtomicSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: TOKEN_FILE_MODE });
}

module.exports = { writeFileAtomicSync, saveTokensSync, TOKEN_FILE_MODE };
