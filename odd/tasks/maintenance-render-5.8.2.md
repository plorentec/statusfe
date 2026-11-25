# Maintenance rendering hotfix 5.8.2
Publish the isolated maintenance-template correction as a new GitHub patch release, without deploying or accessing live databases.
Base: ddf9bfe563869b5a4d40379e4049f48501927605 (published main/tag5.8.1=c6d8833). Risk:item5(release metadata/delivery); template-only fix itself has no high-risk item.

## Specs
- **S1** — User report verbatim:
```text
En mantenimiento da este error {
error: "Could not find matching close tag for "<%#"."
}
```
- **S2** — "Subelo"
- **S3** — "Publicar 5.8.2 completa" (interactive answer token: authorize-memory-credential-release-5.8.2).

## Tasks
- **T1** [S1-S3] in_progress — Preserve the reproduced small comment fix and regression, bump only package/lock root versions to5.8.2 and add truthful release notes; verify independently and assess/review this coherent unit. Route: parent inline + item5 independent verifier. Commit: pending.
- **T2** [S2] pending — Publish fast-forward main and annotatedv5.8.2 atomically; wait for exact-main-commit GitHub CI. Route: parent push + background CI waiter. Commit: pending.
- **T3** [S2-S3] pending — Create one public latestRelease5.8.2 and verify release/main/tag/version/CI through public API. Route: parent authorized credential-memory API + independent public readback. Commit: evidence pending.

## Log
- **L1** — S1 original request is quoted verbatim above. Parent reproduced it BEFOREfix: node scratch/verify_render.js exit1, both newmaintenancecases fail with exactreportedEJSparsermessage (5reportedfailures). Corrected only a comment in views/admin/maintenance.ejs to remove nestedexpressiondelimiters. Durabletests inexistingrenderharness coveremptylist/create link andpopulatedlist/null/specificcomponentdisplay/titles/edit/deleteactions. GREENsamecommandexit0, allrendercasespassed, diff--check0. No route/model/DB/sharedparser/dependency changes. InitialworkingtreeASSESSunassessableduetounrelateduntrackedfiles, fallbackwriterverificationonly; no reviewstarted.
- **L2** — User then said "Subelo"; accepted complete5.8.2publication ininteractivechoice includingexistingGitHubcredentialONLYinmemory forthisRelease, withoutdisplay/persistence. Prior5.8.1grantconsumed, not reused. No childcredentialgrant. No liveDB/companyaccess/deployment. Preserveunrelateddesign/system.md/html,untrackeddesign/admin-workspace andolderuntrackedODDdocs.
- **L3** — Newbranchfix/maintenance-render-5.8.2 fromddf9bfe, remotemainc6d8833 (parentfetched), package5.8.1beforemetadata. Includeonlytemplate+test+package/lockversions+newchangelog+thistrackingfile; no baseline/migration edits, deps/runtime/CI changes, redesign oradvisoryfixes. Local5.8.1passiveevidenceclosureddf9bfe maypublishwithlinearhistory; canonical5.8.1tagunchanged. No meaningfulREDformetadata; structuralcomparisonappropriate. FinalCIwillrunfullsuiteonexactpackaged5.8.2, so don'tduplicateunchangedlocalfullDBsuite.
