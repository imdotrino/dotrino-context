# @dotrino/context

La memoria y los documentos de una carpeta, buscables por significado y por palabra. Todo
corre en tu máquina: los vectores los calcula un modelo local y la base vive dentro de la
carpeta. Se usa como servidor MCP de Claude Code.

## Qué indexa

- Todos los `.md` de la carpeta, salvo carpetas ocultas, `node_modules`, `dist`, `build`,
  `target`, `coverage`, `vendor`, `out`, `Pods` y `DerivedData`.
- La memoria de Claude Code de esa carpeta (`~/.claude/projects/<carpeta>/memory`).

**Una base por carpeta**: `<carpeta>/.dotrino-context/index.db`. La carpeta lleva su propio
`.gitignore` (`*`), así que nunca entra en un commit. Se niega a indexar la carpeta personal o
la raíz del disco.

## Cómo busca

- **Por significado**: `Xenova/multilingual-e5-small` (384 dimensiones, español e inglés) con
  transformers.js. El modelo se baja una vez a `~/.cache/dotrino/models`.
- **Por palabra**: FTS5 de SQLite.
- Las dos listas se juntan por rango recíproco. Los vectores van como BLOB en `node:sqlite` y
  se comparan en memoria: a esta escala (miles de trozos) son milisegundos, sin extensiones.
- Solo se recalcula lo que cambió (fecha y tamaño, y luego el hash). Si cambia el modelo, se
  reindexa todo.

## Uso

```bash
npm i -g @dotrino/context
dotrino-context index            # indexa la carpeta actual
dotrino-context search "qué llave firma el acta"
dotrino-context status

# como servidor MCP, para todas las carpetas (cada una con su base)
claude mcp add -s user dotrino-context -- dotrino-context serve
```

El servidor expone dos herramientas: `search` (consulta, `k`, prefijo de ruta) y `reindex`.
La búsqueda refresca el índice sola si pasaron más de 30 s desde la última pasada.

Variables: `DOTRINO_CONTEXT_MODEL` (otro modelo de Hugging Face), `DOTRINO_CONTEXT_MODELS`
(otra caché de modelos).

Requiere Node ≥ 22.13 (`node:sqlite`).

## Desarrollo

```bash
npm install
npm test
```

Se publica desde CI al etiquetar `vX.Y.Z` (`.github/workflows/release.yml`).
