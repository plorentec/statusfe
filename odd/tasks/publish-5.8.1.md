# Publish migration patch 5.8.1
Publish the already verified migration patch to GitHub so the company can update again; do not deploy or access company databases.
Source branch: fix/legacy-migration-5.8.1. Prepared fix e50aedf / metadata1cea507 / localclosure dcd6208. Risk:item5(delivery/CI/release).

## Specs
- **S1** — "Subelo a github para que la empresa vuelva a actualizar"
- **S2** — "Autorizar la Release 5.8.1" (interactive answer token: authorize-memory-credential-release-5.8.1).

## Tasks
- **T1** [S1] in_progress — Independently check the exact source/metadata and preserved unrelated edits; publish a fast-forward main and annotatedv5.8.1 atomically. Route: parent + read-only independent item5 verifier. Commit: pending.
- **T2** [S1] pending — Wait for exact-commit GitHub CI and verify public main/tag/version. Route: background waiter + independent readback. Commit: evidence pending.
- **T3** [S1-S2] pending — Create one public latest Release5.8.1 with truthful tests/limits; verify via public API. Route: parent API credential in memory only + independent public verifier. Commit: evidence pending.

## Log
- **L1** — User request verbatim: "Subelo a github para que la empresa vuelva a actualizar"
- **L2** — Source fix and metadata independently verified, core review-093d5cd3f78ce4a0 and metadata review-adc9c09f7da222a7 approved/acknowledged/burned. No source changes or re-review of consumed candidates planned. Local final36/36suite/focused46/independentB14/14passed; actualPostgreSQL unavailable. Pre2.2missingcomponents.group_id unsupported; exact company sourceversion unknown. Do not claim blanketallpre2.9compatibility; retain conspicuous release warning. No DB access/deployment in scope.
- **L3** — Read-only preflight: remote main1d2fd91208a069dc15ac3ae48aca1701c0b1ec4d, localtipdcd6208; five unpushedcommits include two passive5.8.0evidenceclosures plus three5.8.1units. Remotev5.8.1tag absent and publicReleaseAPI404. Localgh absent. Unrelateddesign/system.{md,html}, design/admin-workspace/, olderreview/accessibilityODDfiles remain untouched/unpublished.
- **L4** — Human explicitly selected "Autorizar la Release 5.8.1": authorizes existing GitHub credential ONLY in process memory for create/verifyRelease5.8.1; no plaintext printing/persistence, no credentialfile inspections, no other releases. Previous5.8.0grant not reused. Use opaque configuredgit auth for fetch/push; API credentialviaonecapturedgitcredentialfill and in-memoryHTTPSrequest only; no redirects, no credentialstdout/stderr. No privatepaths/production/SSH.
