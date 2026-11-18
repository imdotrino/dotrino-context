// La base de una carpeta: SQLite de Node (`node:sqlite`, sin dependencias). Los vectores van
// como BLOB y se comparan en memoria: a esta escala (miles de trozos) recorrerlos todos tarda
// milisegundos, y no hace falta ninguna extensión. FTS5 da la búsqueda por palabra.
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureContextDir } from './paths.js'

export const SCHEMA_VERSION = '1'

/**
 * @typedef {{ id: number, path: string, heading: string, line: number, text: string }} ChunkRow
 */

export class Store {
  /**
   * @param {string} file  ruta de la base, o ':memory:'
   */
  constructor (file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      pragma journal_mode = wal;
      pragma busy_timeout = 5000;
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists files (path text primary key, mtime real not null, size integer not null, hash text not null);
      create table if not exists chunks (id integer primary key, path text not null, heading text not null, line integer not null, text text not null, vec blob not null);
      create index if not exists chunks_path on chunks(path);
      create virtual table if not exists chunks_fts using fts5(heading, text, tokenize = 'unicode61 remove_diacritics 2');
    `)
    /** @type {{ ids: Int32Array, vecs: Float32Array, dims: number } | null} */
    this.cache = null
  }

  /** @param {string} root */
  static open (root) {
    return new Store(path.join(ensureContextDir(root), 'index.db'))
  }

  /** @param {string} key */
  getMeta (key) {
    const r = /** @type {{ value: string } | undefined} */ (this.db.prepare('select value from meta where key = ?').get(key))
    return r ? r.value : null
  }

  /** @param {string} key @param {string} value */
  setMeta (key, value) {
    this.db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value)
  }

  /**
   * Si cambió el modelo o el esquema, los vectores viejos no se pueden comparar con los
   * nuevos: se borra todo y se vuelve a indexar. Nada de mezclar.
   * @param {string} model
   */
  ensureModel (model) {
    if (this.getMeta('model') === model && this.getMeta('schema') === SCHEMA_VERSION) return false
    this.db.exec('delete from chunks; delete from chunks_fts; delete from files;')
    this.setMeta('model', model)
    this.setMeta('schema', SCHEMA_VERSION)
    this.cache = null
    return true
  }

  /** @returns {Map<string, { mtime: number, size: number, hash: string }>} */
  files () {
    const rows = /** @type {any[]} */ (this.db.prepare('select path, mtime, size, hash from files').all())
    return new Map(rows.map(r => [r.path, { mtime: r.mtime, size: r.size, hash: r.hash }]))
  }

  /** @param {string} p @param {number} mtime @param {number} size */
  touchFile (p, mtime, size) {
    this.db.prepare('update files set mtime = ?, size = ? where path = ?').run(mtime, size, p)
  }

  /**
   * Reemplaza los trozos de un archivo, en una transacción.
   * @param {string} p
   * @param {{ mtime: number, size: number, hash: string }} stat
   * @param {{ heading: string, line: number, text: string }[]} chunks
   * @param {Float32Array[]} vecs
   */
  replaceFile (p, stat, chunks, vecs) {
    this.db.exec('begin')
    try {
      this.#deleteChunks(p)
      const ins = this.db.prepare('insert into chunks (path, heading, line, text, vec) values (?, ?, ?, ?, ?)')
      const fts = this.db.prepare('insert into chunks_fts (rowid, heading, text) values (?, ?, ?)')
      chunks.forEach((c, i) => {
        const v = vecs[i]
        const r = ins.run(p, c.heading, c.line, c.text, new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
        fts.run(r.lastInsertRowid, c.heading, c.text)
      })
      this.db.prepare('insert into files (path, mtime, size, hash) values (?, ?, ?, ?) on conflict(path) do update set mtime = excluded.mtime, size = excluded.size, hash = excluded.hash')
        .run(p, stat.mtime, stat.size, stat.hash)
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    this.cache = null
  }

  /** @param {string} p */
  removeFile (p) {
    this.db.exec('begin')
    try {
      this.#deleteChunks(p)
      this.db.prepare('delete from files where path = ?').run(p)
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    this.cache = null
  }

  /** @param {string} p */
  #deleteChunks (p) {
    this.db.prepare('delete from chunks_fts where rowid in (select id from chunks where path = ?)').run(p)
    this.db.prepare('delete from chunks where path = ?').run(p)
  }

  /** Todos los vectores en un solo bloque, cargados una vez hasta el próximo cambio. */
  vectors () {
    if (this.cache) return this.cache
    const rows = /** @type {{ id: number, vec: Uint8Array }[]} */ (this.db.prepare('select id, vec from chunks order by id').all())
    const dims = rows.length ? rows[0].vec.byteLength / 4 : 0
    const ids = new Int32Array(rows.length)
    const vecs = new Float32Array(rows.length * dims)
    rows.forEach((r, i) => {
      ids[i] = r.id
      vecs.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dims), i * dims)
    })
    this.cache = { ids, vecs, dims }
    return this.cache
  }

  /**
   * @param {string} match  consulta FTS5 ya saneada
   * @param {number} limit
   * @returns {number[]}  ids, del más relevante al menos
   */
  lexical (match, limit) {
    if (!match) return []
    const rows = /** @type {{ rowid: number }[]} */ (this.db.prepare('select rowid from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?').all(match, limit))
    return rows.map(r => r.rowid)
  }

  /** @param {number[]} ids @returns {ChunkRow[]} */
  chunksById (ids) {
    if (!ids.length) return []
    const rows = /** @type {ChunkRow[]} */ (this.db.prepare(`select id, path, heading, line, text from chunks where id in (${ids.map(() => '?').join(',')})`).all(...ids))
    const byId = new Map(rows.map(r => [r.id, r]))
    return /** @type {ChunkRow[]} */ (ids.map(id => byId.get(id)).filter(Boolean))
  }

  stats () {
    const one = (/** @type {string} */ sql) => /** @type {any} */ (this.db.prepare(sql).get()).n
    return { files: one('select count(*) n from files'), chunks: one('select count(*) n from chunks'), model: this.getMeta('model'), indexedAt: this.getMeta('indexedAt') }
  }

  close () { this.db.close() }
}
