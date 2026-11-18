// El servidor MCP ya tiene los modelos cargados; el hook de cada mensaje le pregunta a él por
// un socket local en vez de cargarlos otra vez (eso son segundos por mensaje). Una línea JSON
// de ida, una de vuelta.
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** @param {string} root */
export function socketPath (root, { env = process.env } = {}) {
  const id = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)
  return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `dotrino-context-${id}.sock`)
}

/**
 * Atiende el socket de la carpeta. Si ya lo atiende otro servidor (otra sesión de Claude en
 * la misma carpeta), no hace nada: con uno basta.
 * @param {string} root
 * @param {(req: any) => Promise<any>} handle
 * @param {(m: string) => void} log
 */
export async function listen (root, handle, log) {
  const file = socketPath(root)
  if (await reachable(file)) { log(`socket: ${file} already served`); return null }
  fs.rmSync(file, { force: true })
  const server = net.createServer(conn => {
    let buf = ''
    conn.on('data', d => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      Promise.resolve()
        .then(() => handle(JSON.parse(line)))
        .then(res => conn.end(JSON.stringify({ ok: true, res }) + '\n'))
        .catch(e => conn.end(JSON.stringify({ ok: false, error: String(e?.message || e), code: e?.code || 'error' }) + '\n'))
    })
    conn.on('error', () => {})
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, () => resolve(null)) })
  const cleanup = () => { try { fs.rmSync(file, { force: true }) } catch (_) {} }
  process.once('exit', cleanup)
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(sig, () => { cleanup(); process.exit(0) })
  log(`socket: listening on ${file}`)
  return server
}

/** @param {string} file */
function reachable (file) {
  return new Promise(resolve => {
    const c = net.connect(file)
    c.once('connect', () => { c.end(); resolve(true) })
    c.once('error', () => resolve(false))
  })
}

/**
 * @param {string} root
 * @param {any} req
 * @param {{ timeoutMs?: number }} [opts]
 */
export function ask (root, req, { timeoutMs = 20_000 } = {}) {
  const file = socketPath(root)
  return new Promise((resolve, reject) => {
    const c = net.connect(file)
    let buf = ''
    const timer = setTimeout(() => { c.destroy(); reject(Object.assign(new Error('context server did not answer in time'), { code: 'timeout' })) }, timeoutMs)
    c.once('connect', () => c.write(JSON.stringify(req) + '\n'))
    c.on('data', d => { buf += d })
    c.once('end', () => {
      clearTimeout(timer)
      try {
        const r = JSON.parse(buf)
        if (r.ok) resolve(r.res)
        else reject(Object.assign(new Error(r.error), { code: r.code }))
      } catch (e) { reject(e) }
    })
    c.once('error', e => { clearTimeout(timer); reject(Object.assign(e, { code: /** @type {any} */ (e).code === 'ENOENT' || /** @type {any} */ (e).code === 'ECONNREFUSED' ? 'no-server' : /** @type {any} */ (e).code })) })
  })
}
