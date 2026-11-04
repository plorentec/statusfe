# Feature: Composite components (parent/child aggregation)

**Scope**: local implementation only — no git commit/push, no SSH, no deploy in this task.
**Authorized roots**: everything under `/home/orca/src/StatusFe` (source + `scratch/` + docs).
**Created**: 2026-09-28 (session: composite components)

## Objective

Let an admin create one component that represents a whole service/host (e.g. `yoda`)
and attach several detail components to it (`ping`, `memory`, `disk`, `network`).
The parent's status is **derived = worst status among its children**, so when any child
goes down the parent turns red and returns to green when all children recover.

On the public status page the children are **hidden or shown indented under the parent**,
controlled by a per-parent checkbox (`show_children`), as chosen by the user.

## Problem / why

Today a status page only has flat components + groups + `component_dependencies`.
The dependency cascade (`cascadeStatusChange`, models.js:51-83) is *last-write-wins*:
if `network` recovers while `memory` is still degraded, the dependent flips back to
green. There is no "worst of my parts" concept for a single component row, so a whole
server cannot be represented by one row whose colour aggregates its parts.

## Constraints (standing)

- Express + EJS + PostgreSQL, no linter/typechecker/test framework (AGENTS.md).
- SQL uses `$1,$2,...`; `NOW()`; pg-mem portability (no `= ANY($1::text[])`, no window
  functions, re-running `CREATE TABLE IF NOT EXISTS` throws → use `migrate()`).
- Two sidebars exist; **no new nav item is needed** (feature lives in `/admin/components`).
- Ad-hoc test deps: `npm i --no-save pg-mem jsdom` (installs prune each other).
- UI copy/artifacts in English; user-facing chat in Spanish.

## Design decisions (fixed — do not re-litigate)

1. **Schema** (2 new columns, plain TEXT / INTEGER, **no FK** for portability):
   - `components.parent_id TEXT` (NULL = top-level component)
   - `components.show_children INTEGER DEFAULT 0` (meaningful only for a parent)
   - Added idempotently in `migrate()` with `ALTER TABLE components ADD COLUMN IF NOT EXISTS ...`,
     following the `component_groups.is_global` pattern (init.js:529-544).
   - Parent delete: explicitly `UPDATE components SET parent_id=NULL WHERE parent_id=$1`
     **before** the `DELETE`, so children survive as top-level components
     (covers the single delete and the bulk-delete loop).

2. **Aggregation = write-through, materialized** into `components.status`, so every
   existing read path (admin list, `/api/v1/*`, public page, embed) is correct with no
   extra read-time logic.
   - Severity map (only these 5 values exist in `components.status`):
     `operational 0 < under_maintenance 1 < degraded_performance 2 < partial_outage 3 < major_outage 4`.
     **Any unrecognized value ranks as 2** (never silently green).
   - Hook: a new `recomputeAncestorChain(componentId)` walked up through `parent_id`
     with a `visited` set (cycle-safe), invoked at the end of `cascadeStatusChange()` —
     that function is already called by *every* status write path
     (admin.js:430, api.js:275, models.js:349-362 `update`,
     incidents.create:603, incidents.update:661/676).
   - Each ancestor whose derived status differs is updated with a plain `UPDATE` +
     a `status_history` row (`page_id NULL`, FK-failure tolerated) + `updated_at`.
   - `override_status` on the parent **pins** it: while pinned, children changes do not
     overwrite the parent; the walk still continues upward using the pinned value.
   - Also called explicitly from `components.create` (parent set), `components.delete`
     (former parent) and `components.update` (when `parent_id` changes → recompute BOTH
     the old and the new parent).

3. **Visibility on public pages** (`getForPage` is the single choke point for
   `/status/:slug`, `/embed/:slug`, `/api/v1/status/:slug`, `/api/v1/pages/:slug`):
   - child + parent displayed on this page + `parent.show_children = 0` → child **dropped**.
   - child + parent displayed + `show_children = 1` → child rendered **immediately after
     the parent**, tagged `is_child = 1`, inheriting the parent's `group_name` /
     `group_position` (so every template bucket keeps it adjacent).
   - child whose parent is **not** on this page → rendered standalone (never silently lost).
   - Admin list and `GET /api/v1/components` always show everything (they are not
     page-scoped).

4. **Cycle guard**: a component may not be its own parent nor a descendant of itself
   (`isDescendant` walk). Reject with a validation error, same style as
   `dependencies.wouldCreateCycle` (models.js:1184).

5. **Form**: parent `<select>` (options = all components except self + own descendants)
   and a `show_children` checkbox with an explanatory hint, in the create/edit branch of
   `views/admin/components.ejs` (there is no `component.ejs` — the form is
   components.ejs:109-177).

6. **Admin list**: no new column (avoids colspan/sort/JS churn). Child rows are indented
   and get a small "↳ parent name" tag inside the Name cell.

7. **Out of scope**: `pages.status` remains manual (no auto roll-up of the page banner);
   no changes to `component_dependencies`; no new nav/sidebar item.

## Tasks

- [ ] **T1 — Schema**: add `parent_id` + `show_children` columns idempotently in
      `src/db/init.js` `migrate()` (follow init.js:529-544; keep boot idempotent).
- [ ] **T2 — Aggregation core**: `severity()` + `worstStatus()` + `recomputeAncestorChain()`
      in `src/db/models.js`; wire into `cascadeStatusChange()`; respect `override_status`.
- [ ] **T3 — Model lifecycle**: parent validation + cycle guard in `components.create`,
      `components.update` (allowlist `parent_id`, `show_children`; recompute old+new parent),
      `components.delete` (clear children's `parent_id` first, then recompute former parent);
      attach `parent_name` in `components.list()`.
- [ ] **T4 — Public visibility**: `getForPage` filter/nest per design decision 3; attach
      `parent_id`, `is_child`, `show_children` to the returned rows.
- [ ] **T5 — Admin routes + form**: read `parent_id`/`show_children` in POST/PUT
      (admin.js:300-318, 388-411); pass `parents` local to create/edit GET
      (admin.js:285-298, 368-386); render the select + checkbox in
      `views/admin/components.ejs` form branch; indent + tag child rows in the list branch.
- [ ] **T6 — Public API parity**: accept `parent_id`/`show_children` on
      `POST/PUT /api/v1/components` (api.js:146-187).
- [ ] **T7 — Status page render**: `views/status-page.ejs` — `componentsData` (76-82),
      `renderComponentsHTML` (135-146), default template loop (233-256), grid (322-340),
      dark (410-419): children rendered indented under the parent, hidden when
      `show_children = 0`.
- [ ] **T8 — Tests**: new `scratch/verify_composite.js` (aggregation worst-of, recovery,
      override pin, cycle rejection, delete-parent → children survive + parent recomputes,
      create/delete/reparent recompute, getForPage hide/nest/standalone rules).
      Update `scratch/verify_render.js` (new EJS locals — **ReferenceError otherwise**),
      and any count assertion that breaks (verify_plan.js:97 `=== 5`,
      verify_multigroup.js:71-108, verify_smoke.js:52, verify_list_ui.js fixture).
- [ ] **T9 — Docs**: AGENTS.md — Structure (:24-53), Key quirks (:54-71, one quirk bullet),
      Verification/tests (:120-131, harness bullet).

## Acceptance criteria

1. `yoda` + children `ping/memory/disk/network` all operational → `yoda` green.
2. `network` set to `major_outage` (API and/or incident path) → `yoda` becomes
   `major_outage` **immediately**, in admin list, `/api/v1/components`, `/status/:slug`
   and `/embed/:slug`.
3. `network` recovers while `memory` is still `degraded_performance` → `yoda` shows
   `degraded_performance` (**regression guard against last-write-wins**).
4. All children operational → `yoda` back to `operational`.
5. Manual override on `yoda` = `partial_outage` stays pinned while children change;
   clearing the override returns it to the derived value.
6. `show_children = 0` → children absent from `/status/:slug`, `/embed/:slug`,
   `/api/v1/status/:slug`, `/api/v1/pages/:slug`; still present in admin list and
   `/api/v1/components`.
7. `show_children = 1` → children appear directly under `yoda`, indented, with their
   own colour; parent keeps the aggregated colour.
8. A child whose parent is on another page still renders on its own page.
9. Setting `parent_id` to self or to a descendant is rejected; no infinite loop.
10. Deleting `yoda` keeps `ping/memory/disk/network` (now top-level) with their statuses.
11. `node scratch/verify_composite.js` and all pre-existing harnesses pass.

## Checks (run from repo root)

- `npm i --no-save pg-mem jsdom` (once; they prune each other)
- `node scratch/verify_composite.js` (new)
- `node scratch/verify_plan.js && node scratch/verify_multigroup.js && node scratch/verify_render.js`
- `node scratch/verify_list_ui.js && node scratch/verify_e2e.js && node scratch/verify_smoke.js`
- `node scratch/verify_deps.js && node scratch/verify_bulk_delete.js && node scratch/verify_logo.js && node scratch/verify_update.js`

**TDD mode: OFF** (source: AGENTS.md "No linter, formatter, typechecker, or test framework";
project/session has no strict-TDD config). Test runner for this feature: `node scratch/*.js`.

## Progress

- [x] Design decided + touch-point map produced (file:line, explore agent).
- [ ] T1..T9

## Next step

Implement T1→T9 as one delegated writer task, run all checks, then report actual results.
