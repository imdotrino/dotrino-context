import { readFileSync } from 'node:fs'

/** La versión del package.json: la que está corriendo, no la que pide nadie (§14). */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
