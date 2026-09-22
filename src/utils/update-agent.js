// Self-update agent bridge. The app NEVER touches Docker/git directly: it
// writes an update request file into data/ and a host-side systemd agent
// (scripts/self-update.sh, installed by scripts/install-update-agent.sh)
// consumes it, performs the update, and writes back a result file that the
// admin UI polls via GET /admin/update/status.
//
// State contract (both files live in data/, gitignored):
//   update_request.json — { requestedAt, targetVersion, requestedBy }
//   update_result.json  — { status: in_progress|done|failed|rolled_back,
//                           phase, startedAt, updatedAt, fromVersion,
//                           targetVersion, error? }
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const pkg = require('../../package.json');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const REQUEST_FILE = path.join(DATA_DIR, 'update_request.json');
const RESULT_FILE = path.join(DATA_DIR, 'update_result.json');

// Guards (ms): a request younger than this means the agent has not picked it
// up yet; an in_progress result younger than this means an update is running;
// a request older than NO_AGENT_MS with no fresh in_progress result means
// nobody is listening (no_agent).
const REQUEST_FRESH_MS = 60 * 1000;
const IN_PROGRESS_FRESH_MS = 10 * 60 * 1000;
const NO_AGENT_MS = 20 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/plorentec/statusfe/releases/latest';

const NO_AGENT_HINT = 'No update agent is installed on this host. Install it with scripts/install-update-agent.sh (Docker Compose + systemd), or update manually from the release page.';

// Checked AT CALL TIME (not module load) so tests can toggle it in-process.
function isDisabled() {
  return process.env.SELF_UPDATE_DISABLED === '1' || process.env.SELF_UPDATE_DISABLED === 'true';
}

function nowIso() {
  return new Date().toISOString();
}

function parseTs(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

// Atomic write: tmp file in the same dir + rename (same filesystem → atomic).
function atomicWriteJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

function deleteQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// Resolve the latest published release SERVER-SIDE (the client can never pick
// the target). URL overridable via SELF_UPDATE_RELEASES_URL (http or https —
// tests point it at a local mock). ANY fetch/parse failure resolves to null;
// this function never rejects and never throws.
function resolveLatestVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let url;
    try {
      url = new URL(process.env.SELF_UPDATE_RELEASES_URL || DEFAULT_RELEASES_URL);
    } catch {
      return done(null);
    }
    const mod = url.protocol === 'http:' ? http : https;
    try {
      const req = mod.get(url, {
        headers: {
          // GitHub API rejects requests without a User-Agent (same pattern
          // as the /admin/check-update route).
          'User-Agent': 'StatusFe/' + pkg.version,
          'Accept': 'application/vnd.github+json'
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done(null);
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const tag = release.tag_name || release.name;
            if (!tag) return done(null);
            done(String(tag).replace(/^v/, ''));
          } catch {
            done(null);
          }
        });
      });
      req.on('error', () => done(null));
      req.setTimeout(FETCH_TIMEOUT_MS, () => { req.destroy(); done(null); });
    } catch {
      done(null);
    }
  });
}

// Queue an update. Returns { code, body } — never throws for expected failures.
async function requestUpdate(user) {
  if (isDisabled()) {
    return { code: 501, body: { error: 'Self-update is disabled on this instance (SELF_UPDATE_DISABLED).' } };
  }
  const latest = await resolveLatestVersion();
  if (!latest) {
    return { code: 502, body: { error: 'Could not determine the latest published version.' } };
  }
  if (latest === pkg.version) {
    return { code: 400, body: { error: `Already running the latest version (${latest}).` } };
  }
  // A fresh in_progress result means an update is genuinely running; a stale
  // one means the agent died mid-update → allowed to re-trigger.
  const result = readJsonSafe(RESULT_FILE);
  if (result && result.status === 'in_progress' &&
      (Date.now() - parseTs(result.updatedAt)) < IN_PROGRESS_FRESH_MS) {
    return { code: 409, body: { error: 'An update is already in progress.' } };
  }
  // An unconsumed request younger than 60 s means the agent may still pick it
  // up; older means the agent is down → delete it and proceed.
  const request = readJsonSafe(REQUEST_FILE);
  if (request && (Date.now() - parseTs(request.requestedAt)) < REQUEST_FRESH_MS) {
    return { code: 409, body: { error: 'An update is already in progress.' } };
  }
  atomicWriteJson(REQUEST_FILE, {
    requestedAt: nowIso(),
    targetVersion: latest,
    requestedBy: (user && user.email) || 'unknown'
  });
  deleteQuiet(RESULT_FILE);
  return { code: 202, body: { status: 'queued', targetVersion: latest } };
}

// Status snapshot for the polling UI. Returns { code, body } — never throws
// for missing/garbage files (200 except when disabled → 501).
function getUpdateStatus() {
  if (isDisabled()) {
    return { code: 501, body: { error: 'Self-update is disabled on this instance (SELF_UPDATE_DISABLED).' } };
  }
  const result = readJsonSafe(RESULT_FILE);
  const request = readJsonSafe(REQUEST_FILE);
  if (result) {
    return { code: 200, body: Object.assign({}, result, { currentVersion: pkg.version }) };
  }
  if (request) {
    const age = Date.now() - parseTs(request.requestedAt);
    if (age > NO_AGENT_MS) {
      return {
        code: 200,
        body: {
          status: 'no_agent',
          requestedVersion: request.targetVersion,
          targetVersion: request.targetVersion,
          currentVersion: pkg.version,
          hint: NO_AGENT_HINT
        }
      };
    }
    return { code: 200, body: { status: 'queued', targetVersion: request.targetVersion, currentVersion: pkg.version } };
  }
  return { code: 200, body: { status: 'idle', currentVersion: pkg.version } };
}

module.exports = {
  DATA_DIR,
  REQUEST_FILE,
  RESULT_FILE,
  isDisabled,
  resolveLatestVersion,
  requestUpdate,
  getUpdateStatus,
  atomicWriteJson,
  readJsonSafe,
  deleteQuiet
};