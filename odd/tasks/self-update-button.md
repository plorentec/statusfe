# Feature: Self-update button ("Actualizar ahora")

## Objective
Add a button in `/admin/changelog` that updates a Docker-Compose+systemd deployment to the latest published GitHub release — fully autonomous per click, with health-check and automatic rollback on failure. The app never touches Docker; a host-side agent consumes a trigger file from the shared `data/` volume.

## Problem / Why
Manual deploy today requires SSH to the host and running `git fetch && git reset --hard origin/main && docker compose build && up -d`. Users (and the company) want one-click updates without giving the container power over the host.

## Decisions (user-approved, 2026-09-22)
- Mechanism: **(a) host systemd agent** (trigger file + `.path` unit + oneshot `.service`), NOT docker.sock mount.
- Source: **(a) latest published GitHub release tag** (same source `/admin/check-update` reports), NOT origin/main.
- Default enabled; `SELF_UPDATE_DISABLED=1` opts out (routes return 501 + explanation).
- Target is resolved **server-side** (never accepted from the client).

## Scope
- App-side (generic, works for any deployment): routes + state files + UI.
- Host-side applier: bash script + 2 systemd unit templates + installer script (Docker-Compose variant; bare-metal variant documented, not installed).
- No Kubernetes integration.

## Constraints
- `data/` dir resolution: `path.join(__dirname, '..', '..', 'data')` (see `src/app.js:8`).
- Routes must be `requireAdmin` + protected by the existing CSRF middleware (`x-csrf-token`).
- Atomic file writes (tmp + rename) for both trigger and result.
- App must degrade honestly when no agent consumes the trigger (20 s → `no_agent` status; button disabled with link to release).
- Agent script must not live inside the repo checkout it swaps (runs from `/usr/local/bin` after install) to avoid self-modification mid-run.
- No test framework; regression = scratch harness (`pg-mem`, installed ad-hoc `npm i --no-save pg-mem`).
- GitHub URL overridable via `SELF_UPDATE_RELEASES_URL` (tests point it at a local mock).

## Contract (files in `data/`)
- `update_request.json` — `{ requestedAt, targetVersion, requestedBy }`. Written by POST /admin/update; consumed (deleted) by the agent.
- `update_result.json` — `{ status: in_progress|done|failed|rolled_back, phase, startedAt, updatedAt, fromVersion, targetVersion, error? }`. Written by the agent at every phase transition.

## Tasks
- [x] T1 — `src/utils/update-agent.js`: file state (atomic read/write/delete), server-side latest-release resolution (env override), request/status business logic (in-progress guard, no-agent detection).
- [x] T2 — `src/routes/admin.js`: `POST /admin/update` (202/400/403/409/501/502), `GET /admin/update/status` (requireAdmin, JSON state).
- [x] T3 — `views/admin/changelog.ejs`: Update now button in the hasUpdate branch, 2 s polling, phase display, done→auto-reload, failed/rolled_back→error, no_agent→disabled+hint.
- [x] T4 — `scripts/self-update.sh` (heartbeat, git checkout tag, compose build/up, 60 s health wait, rollback to previous commit, honest result states, always exit 0, consume request first) + `scripts/install-update-agent.sh` (sed-inject volume path/repo dir, install units, enable .path, uninstall arg).
- [x] T5 — `systemd/statusfe-update.path` + `systemd/statusfe-update.service` templates with `__TRIGGER_PATH__` / `__SELF_UPDATE_BIN__` placeholders.
- [x] T6 — `.gitignore`: `data/update_request.json`, `data/update_result.json`.
- [x] T7 — `scratch/verify_update.js`: mock GitHub server; shape of status; unauthenticated POST rejected; CSRF missing → 403; valid POST → 202 + trigger file content; target==current → 400; in-progress result → 409; stale unconsumed request → no_agent; SELF_UPDATE_DISABLED → 501 (call-time env toggle); 502 on unreachable/broken JSON; TOTAL FAIL=0.
- [x] T8 — Docs: AGENTS.md structure block + self-update section (corrected) + CHANGELOG [Unreleased] + README one-liner (English artifacts).
- [x] T9 — Verification: `bash -n` scripts ✓; all 7 harnesses FAIL=0 ✓.
- [ ] T10 — Ship (parent-owned): commit, push, tag v2.2.5, GitHub release, deploy yoda, install agent, live loop-test incl. forced-rollback check.

## Acceptance criteria
- Fresh app with no agent: button click → honest `no_agent` state within ~20 s, no hang.
- App with agent: click → phases visible → reload on new version; broken target tag → auto `rolled_back`, site healthy.
- All existing 6 harnesses still green; new harness green.

## Checks (TDD off — source: AGENTS.md "No linter, formatter, typechecker, or test framework")
- `node scratch/verify_update.js`, `node scratch/verify_smoke.js`, `node scratch/verify_e2e.js`, `node scratch/verify_plan.js`, `node scratch/verify_multigroup.js`, `node scratch/verify_deps.js`, `node scratch/verify_render.js`
- `bash -n scripts/self-update.sh scripts/install-update-agent.sh`

## Progress
- T1–T3: write — implemented update-agent.js (atomic ops, release resolution, request/status guards), admin.js routes (POST /admin/update + GET /admin/update/status), changelog.ejs (Update now button + 2s polling + phase display + no_agent/done/failed/rolled_back handling).
- T4–T6: write — implemented self-update.sh (consume-first, grep/sed parsing, tmp+mv result, build/swap/health, rollback to prev_commit on any failure, always exit 0), install-update-agent.sh (uninstall arg, sed __TRIGGER_PATH__/__SELF_UPDATE_BIN__, chmod 755), systemd templates (PathExists + [Path] Unit=), .gitignore entries.
- T7–T9: write — full regression harness (idle, no-login, missing-CSRF 403, 202 + file, 409 dup, in_progress display, no_agent + hint, done, 501 call-time toggle, 502 unreachable + 502 bad-json, 400 same-version, TOTAL FAIL=0); bash -n passes; all 7 harnesses PASS (FAIL=0).
- Concurrent note: a parallel writer operated on scripts/, systemd/, CHANGELOG.md, AGENTS.md, changelog.ejs, and a separate verify_update.js. Their harness used an incompatible API contract ({code, body} vs {ok, code, reason}) and did not meet the enumerated checks. Scripts/deviated from the spec (no rollback on build/health failure, exit 1, wrong result status, no uninstall). All were replaced with spec-compliant versions. AGENTS.md section and CHANGELOG Added section preserved from the parallel writer (already accurate) with my corrections to the status-route 501 claim and structure block.

## Next step
- Delegate T1–T9 to one writer; parent handles T10.
