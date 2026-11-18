// Dónde vive cada cosa. La base es POR CARPETA: cada carpeta raíz tiene la suya en
// `<raíz>/.dotrino-context/`, y nada de lo indexado sale de ahí.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

export const CONTEXT_DIRNAME = '.dotrino-context'

/** @param {string} root */
export function contextDir (root) {
  return path.join(path.resolve(root), CONTEXT_DIRNAME)
}

/**
 * Crea la carpeta de la base con un `.gitignore` de una sola línea (`*`), para que ningún
 * repo tenga que acordarse de ignorarla y lo indexado no acabe en un commit.
 * @param {string} root
 */
export function ensureContextDir (root) {
  const dir = contextDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
  return dir
}

/**
 * La memoria de Claude Code para esta carpeta: `~/.claude/projects/<slug>/memory`, donde el
 * slug es la ruta con todo lo que no es letra o número cambiado por `-`.
 * @param {string} root
 * @param {{ home?: string }} [opts]
 */
export function claudeMemoryDir (root, { home = os.homedir() } = {}) {
  return path.join(home, '.claude', 'projects', projectSlug(root), 'memory')
}

/** Los modelos se comparten entre carpetas: son el mismo archivo para todas. */
export function modelCacheDir ({ home = os.homedir(), env = process.env } = {}) {
  return env.DOTRINO_CONTEXT_MODELS || path.join(home, '.cache', 'dotrino', 'models')
}

/**
 * Dónde corren los modelos. `cpu` por defecto; `cuda` lo pide quien tiene la GPU y las
 * bibliotecas de CUDA 12 + cuDNN 9 en LD_LIBRARY_PATH. Si se pide `cuda` y no está, falla al
 * cargar el modelo y lo dice: no se cae a CPU en silencio.
 * @returns {{ device: 'cpu' | 'cuda', dtype: 'q8' | 'fp16' }}
 */
export function runtime ({ env = process.env } = {}) {
  const device = env.DOTRINO_CONTEXT_DEVICE || 'cpu'
  if (device !== 'cpu' && device !== 'cuda') throw Object.assign(new Error(`DOTRINO_CONTEXT_DEVICE must be cpu or cuda, got ${device}`), { code: 'bad-device' })
  // En la GPU los modelos cuantizados a int8 son lentos (sus operaciones vuelven a la CPU):
  // allí va fp16. En la CPU, q8.
  return device === 'cuda' ? { device, dtype: 'fp16' } : { device, dtype: 'q8' }
}

/**
 * La cadena de bases de una carpeta: la suya primero (siempre tiene base propia) y después la
 * de cada padre, subiendo MIENTRAS el padre tenga base (`.dotrino-context/`) y parando en el
 * primero que no la tenga. Las de los padres son subcontexto: completan, no sustituyen.
 * @param {string} start
 * @returns {string[]}
 */
export function baseChain (start) {
  const chain = [path.resolve(start)]
  for (;;) {
    const dir = chain[chain.length - 1]
    const parent = path.dirname(dir)
    if (parent === dir || !fs.existsSync(path.join(parent, CONTEXT_DIRNAME))) return chain
    chain.push(parent)
  }
}

/** @param {string} dir */
export function projectSlug (dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-')
}

