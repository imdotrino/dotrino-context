# @dotrino/context

La memoria y los documentos de una carpeta, buscables por significado y por palabra. Todo
corre en tu máquina: los vectores los calcula un modelo local y la base vive dentro de la
carpeta. Se usa como servidor MCP de Claude Code.

**Uso:** [wiki.dotrino.com/desarrollo/contexto](https://wiki.dotrino.com/desarrollo/contexto/). Este README es técnico.

## Qué indexa

| Tipo | Qué | Cuándo entra |
|---|---|---|
| `doc` | Todos los `.md` de la carpeta, salvo carpetas ocultas, `node_modules`, `dist`, `build`, `target`, `coverage`, `vendor`, `out`, `Pods`, `DerivedData` y lo que diga `.dotrino-contextignore`. Los de más de 512 KB se saltan y `status` los lista. | al cambiar fecha o tamaño |
| `memory` | La memoria de Claude Code de esa carpeta (`~/.claude/projects/<carpeta>/memory`). | ídem |
| `git` | Los mensajes de commit de cada repo que haya en la carpeta, uno por commit. | al cambiar el HEAD |
| `conv` | Las conversaciones de Claude Code de esa carpeta: solo lo que dijo la persona y el texto de la respuesta. Fuera herramientas, salidas y razonamiento. | cuando llevan 10 min sin cambiar |

Antes de entrar, a los commits y a las conversaciones se les tapa lo que parezca un secreto
(llaves privadas, tokens conocidos, `password=…`). Es una red, no una garantía.

**Una base por carpeta**: `<carpeta>/.dotrino-context/index.db`. La carpeta lleva su propio
`.gitignore` (`*`), así que nunca entra en un commit. Se niega a indexar la carpeta personal o
la raíz del disco.

La memoria y las conversaciones de Claude Code entran de la carpeta **y de sus subcarpetas**:
una sesión abierta en `proyecto/app` también cuenta para la base de `proyecto`. El nombre de esas
carpetas de Claude es ambiguo, así que una entra solo si alguna de sus conversaciones dice que
se abrió dentro.

### Subcarpetas: base propia y subcontexto de arriba

Cada carpeta tiene su base. Al buscar, se consulta la propia y, como **subcontexto**, la de cada
carpeta padre, subiendo **mientras el padre tenga base** y parando en el primero que no la
tenga. Lo de la base propia sale primero (medio punto de ventaja en el orden); lo de arriba
llega marcado «contexto de arriba». Un mismo trozo que está en las dos sale una vez, de la
propia. El servidor mantiene al día toda la cadena, la propia primero.

### `.dotrino-contextignore`

En la raíz de la carpeta, con la sintaxis corta de `.gitignore`: sin `/` vale en cualquier
nivel, con `/` al principio desde la raíz, con `/` al final solo carpetas. Excluir una carpeta
excluye también los commits de los repos que tenga dentro.

### Cuando dos resultados se contradicen

La base no decide qué es verdad: cada resultado dice su **tipo** y su **fecha**, y la regla está
en la descripción de la herramienta. Un `doc` o una `memory` son el estado actual y ganan a un
`git` o una `conv`, que son historia; los documentos de norma de la carpeta ganan a todo; entre
dos del mismo tipo, gana el más nuevo. Para corregir lo que la base devuelve, se corrige la
fuente: el `.md`, o una nota de memoria con la decisión vigente.

## Cómo busca

1. **Por significado**: `Xenova/multilingual-e5-base` (768 dimensiones, español e inglés), con
   transformers.js.
2. **Por palabra**: FTS5 de SQLite.
3. Las dos listas se juntan por rango recíproco, y un **reordenador**
   (`onnx-community/bge-reranker-v2-m3-ONNX`, multilingüe) lee la pregunta junto a cada uno de
   los 30 primeros candidatos y los ordena. Los documentos y la memoria llevan un punto de
   ventaja sobre los commits y las conversaciones.
4. Un commit que está en dos repos sale una vez; dos trozos de la misma sección salen juntos.

Los modelos se bajan una vez a `~/.cache/dotrino/models`. Los vectores van como BLOB en
`node:sqlite` y se comparan en memoria, sin extensiones. Solo se recalcula lo que cambió: cada
fuente tiene un sello barato (fecha y tamaño, o el HEAD) y cada documento una versión (un hash).
Si cambia el modelo, se reindexa todo. Lo que desaparece de la fuente desaparece de la base, y
el archivo se compacta.

### GPU

Con `DOTRINO_CONTEXT_DEVICE=cuda` los modelos corren en la GPU, en fp16. Hace falta:

- el proveedor CUDA de onnxruntime, que npm no trae: `node node_modules/onnxruntime-node/script/install.js --onnxruntime-node-install=cuda12`
  (el nombre dice 12, pero la 1.30 está compilada para **CUDA 13**);
- las bibliotecas de CUDA 13 y cuDNN 9 en `LD_LIBRARY_PATH`. Sin `sudo`, en un entorno de
  Python: `pip install nvidia-cuda-runtime==13.0.96 nvidia-cublas==13.1.2.11 nvidia-cudnn-cu13 nvidia-curand nvidia-cufft nvidia-cuda-nvrtc`.

Si se pide `cuda` y no está, falla al cargar el modelo y lo dice: no vuelve a la CPU en silencio.

Medido sobre 17.101 trozos (RTX 4060 Ti): indexar todo, 2 min 8 s en GPU contra 11 min 17 s en
CPU; una búsqueda con reordenador, ~400 ms.

## Uso

```bash
npm i -g @dotrino/context
dotrino-context index            # indexa la carpeta actual
dotrino-context search "qué llave firma el acta"
dotrino-context status           # fuentes, trozos por tipo, lo saltado por tamaño

# servidor MCP para todas las carpetas (cada una con su base)
claude mcp add -s user dotrino-context -e DOTRINO_CONTEXT_DEVICE=cuda -e LD_LIBRARY_PATH=… -- dotrino-context serve
```

El servidor expone `search` (consulta, `k`, prefijo de ruta) y `reindex`. La búsqueda refresca
el índice si pasaron más de 30 s; con la base ya hecha, la pasada sigue por detrás y no la hace
esperar. El servidor se apaga cuando se cierra Claude Code.

### Contexto en cada mensaje

`dotrino-context hook` es un hook `UserPromptSubmit`: con cada mensaje busca y añade al contexto
los trozos que el reordenador puntúa por encima de 0 (hasta 6). Le pregunta al servidor de esa
carpeta por un socket local (`$XDG_RUNTIME_DIR/dotrino-context-<id>.sock`), así que no carga
los modelos otra vez. Los mensajes de menos de 4 palabras no se buscan. Sin servidor, lo dice
en una línea.

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "dotrino-context hook", "timeout": 30 }
] } ] } }
```

Variables: `DOTRINO_CONTEXT_DEVICE` (`cpu` o `cuda`), `DOTRINO_CONTEXT_MODEL`,
`DOTRINO_CONTEXT_RERANKER`, `DOTRINO_CONTEXT_MODELS` (caché de modelos).

## Desarrollo

```bash
npm install
npm test
```

Se publica desde CI al etiquetar `vX.Y.Z` (`.github/workflows/release.yml`).
