# Scripts de verificación (sin framework de tests)

El proyecto no tiene framework de tests. Estos scripts verifican la lógica del
plan v2.2.0 contra una **PostgreSQL en memoria** (`pg-mem`, no es dependencia del
proyecto — se instala temporalmente):

```bash
npm install --no-save pg-mem

node scratch/verify_plan.js    # modelos: grupos, getForPage, sanitización
node scratch/verify_render.js  # render de todas las plantillas tocadas
node scratch/verify_smoke.js   # app completa arrancada + HTTP (health, status, embed, audit)
node scratch/verify_e2e.js     # E2E: login → crear componente con grupo nuevo → página → pública
```

Cada script imprime PASS/FAIL por caso y sale con código 0/1.
Nota: `pg-mem` no soporta todo PostgreSQL real (window functions, `integer * interval`,
subconsultas correlacionadas en lista SELECT) — las queries del proyecto usan formas
portables compatibles con ambos.
