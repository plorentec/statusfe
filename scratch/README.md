# Scripts de verificación (sin framework de tests)

El proyecto no tiene framework de tests. Estos scripts verifican la lógica del
plan v2.2.3 contra una **PostgreSQL en memoria** (`pg-mem`, no es dependencia del
proyecto — se instala temporalmente):

```bash
npm install --no-save pg-mem

node scratch/verify_plan.js       # modelos: grupos, resolveGroup, getForPage, sanitización, seguridad v2.2.1, regresiones v2.2.4
node scratch/verify_multigroup.js # multi-grupo: setGroups/setMembers/resolveGroup, expansión en getForPage, backfill, getGroupIdsForPage, is_global, regression "quitar grupo de página", migrate idempotente
node scratch/verify_deps.js       # dependencias: hub muchos-a-uno, cascada transitiva, ciclos, CSV safety, admin analytics page→components
node scratch/verify_render.js     # render de todas las plantillas tocadas (+ CSRF, badges de grupo, pre-marcado, changelog dinámico)
node scratch/verify_sidebar_a11y.js # ambas barras laterales: botones, aria-expanded/controls, hidden, Escape y retorno del foco (requiere jsdom)
node scratch/verify_smoke.js      # app completa arrancada + HTTP (health, status, embed, audit, cookies basura, 403 CSRF, guards de crash v2.2.4, redirect loop 2FA, role=user)
node scratch/verify_e2e.js        # E2E: login → CSRF → componente con grupo nuevo → página → pública; estados; multi-grupo; miembros; API keys; 2FA
```

Cada script imprime PASS/FAIL por caso y sale con código 0/1.

El arnés de la barra lateral renderiza las dos plantillas reales en ES/EN y
carga `public/js/admin.js`. Conserva la apertura de la sección activa y comprueba
que los submenús cerrados queden ocultos también para el teclado. Para el uso
normal, Enter o Espacio activan los botones de sección; Escape desde un submenú
lo cierra y devuelve el foco a su botón. jsdom verifica el estado y los eventos,
pero no acredita por sí solo la activación nativa del navegador ni el orden real
de Tab: esas comprobaciones requieren una prueba con navegador. Este cambio no
resuelve las limitaciones de la barra compacta en pantallas pequeñas ni acredita
conformidad WCAG completa.

Nota: `pg-mem` no soporta todo PostgreSQL real — limitaciones conocidas que el
código del proyecto respeta para mantener las queries portables:

- No soporta `= ANY($1::text[])` (falla o se comporta mal) → usar listas `IN ($1,$2,...)` con placeholders.
- No soporta window functions (`OVER`) ni `integer * interval` (usar `(n::text || ' minutes')::interval`).
- No soporta subconsultas correlacionadas en la lista SELECT (DISTINCT ON + LEFT JOIN sí funciona).
- Re-ejecutar `CREATE TABLE IF NOT EXISTS` sobre tablas existentes lanza error → desde 3.7.0 `init()` es seguro dos veces (las migraciones se aplican una sola vez), pero si un arnés necesita volver a ejecutar el payload legacy debe llamar a `src/db/migrations/002-columns-and-backfills.js` `.up()` directamente, no a `migrate()`.
