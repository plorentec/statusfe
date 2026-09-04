# Scripts de verificación (sin framework de tests)

El proyecto no tiene framework de tests. Estos scripts verifican la lógica del
plan v2.2.2 contra una **PostgreSQL en memoria** (`pg-mem`, no es dependencia del
proyecto — se instala temporalmente):

```bash
npm install --no-save pg-mem

node scratch/verify_plan.js       # modelos: grupos, resolveGroup, getForPage, sanitización, seguridad v2.2.1
node scratch/verify_multigroup.js # multi-grupo: setGroups/setMembers/resolveGroup, expansión en getForPage, backfill, getGroupIdsForPage
node scratch/verify_render.js     # render de todas las plantillas tocadas (+ CSRF, badges de grupo, pre-marcado)
node scratch/verify_smoke.js      # app completa arrancada + HTTP (health, status, embed, audit, cookies basura, 403 CSRF)
node scratch/verify_e2e.js        # E2E: login → CSRF → componente con grupo nuevo → página → pública; estados; multi-grupo; miembros; API keys; 2FA
```

Cada script imprime PASS/FAIL por caso y sale con código 0/1.

Nota: `pg-mem` no soporta todo PostgreSQL real — limitaciones conocidas que el
código del proyecto respeta para mantener las queries portables:

- No soporta `= ANY($1::text[])` (falla o se comporta mal) → usar listas `IN ($1,$2,...)` con placeholders.
- No soporta window functions (`OVER`) ni `integer * interval` (usar `(n::text || ' minutes')::interval`).
- No soporta subconsultas correlacionadas en la lista SELECT (DISTINCT ON + LEFT JOIN sí funciona).
- Re-ejecutar `CREATE TABLE IF NOT EXISTS` sobre tablas existentes lanza error → en los harness llamar a `migrate()` (exportada de `src/db/init.js`) en vez de `init()` dos veces.
