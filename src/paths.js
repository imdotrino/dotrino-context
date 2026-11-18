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
  const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-')
  return path.join(home, '.claude', 'projects', slug, 'memory')
}

/** Los modelos se comparten entre carpetas: son el mismo archivo para todas. */
export function modelCacheDir ({ home = os.homedir(), env = process.env } = {}) {
  return env.DOTRINO_CONTEXT_MODELS || path.join(home, '.cache', 'dotrino', 'models')
}
