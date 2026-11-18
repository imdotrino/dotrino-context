// La base de una carpeta: SQLite de Node (`node:sqlite`, sin dependencias). Los vectores van
// como BLOB y se comparan en memoria: a esta escala (decenas de miles de trozos) recorrerlos
// todos tarda milisegundos, y no hace falta ninguna extensión. FTS5 da la búsqueda por palabra.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureContextDir } from './paths.js'

export const SCHEMA_VERSION = '2'

/**
 * @typedef {{ id: number, path: string, kind: string, date: string, heading: string, line: number, text: string }} ChunkRow
 */

const SCHEMA = `
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists containers (key text primary key, kind text not null, stamp text not null);
  create table if not exists docs (key text primary key, container text not null, version text not null);
  create index if not exists docs_container on docs(container);
  create table if not exists chunks (id integer primary key, doc text not null, path text not null, kind text not null, date text not null, heading text not null, line integer not null, text text not null, vec blob not null);
  create index if not exists chunks_doc on chunks(doc);
  create virtual table if not exists chunks_fts using fts5(heading, text, tokenize = 'unicode61 remove_diacritics 2');
`

export class Store {
  /**
   * @param {string} file  ruta de la base, o ':memory:'
   */
  constructor (file) {
    this.file = file
    // Otro esquema es otra base: se tira el archivo entero ANTES de tocarlo y se empieza de
    // cero. Así no conviven tablas de dos versiones, y el auto_vacuum (que solo se fija al
    // crear) queda puesto.
    let db = new DatabaseSync(file)
    const hasMeta = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'meta'").get()
    const v = hasMeta ? /** @type {{ value: string } | undefined} */ (db.prepare("select value from meta where key = 'schema'").get())?.value : null
    const fresh = !hasMeta && !db.prepare("select 1 from sqlite_master where type = 'table'").get()
    if (!fresh && v !== SCHEMA_VERSION) {
      db.close()
      if (file !== ':memory:') for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
      db = new DatabaseSync(file)
    }
    db.exec('pragma busy_timeout = 5000; pragma auto_vacuum = incremental; pragma journal_mode = wal;')
    db.exec(SCHEMA)
    this.db = db
    this.setMeta('schema', SCHEMA_VERSION)
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
   * Si cambió el modelo, los vectores viejos no se pueden comparar con los nuevos: se borra
   * todo y se vuelve a indexar. Nada de mezclar.
   * @param {string} model
   */
  ensureModel (model, { rebuild = false } = {}) {
    const built = this.getMeta('model')
    if (built === model) return false
    // Una base hecha con otro modelo (o la misma en otra precisión: q8 en CPU, fp16 en GPU) no
    // se borra sola: lo hacía, y una orden lanzada sin DOTRINO_CONTEXT_DEVICE tiraba la base
    // del servidor entera. Rehacerla es una decisión: `index --rebuild`.
    if (built && !rebuild) throw Object.assign(new Error(`base built with ${built}, this process uses ${model}; set DOTRINO_CONTEXT_DEVICE to match, or run \`dotrino-context index --rebuild\``), { code: 'model-mismatch' })
    this.db.exec('delete from chunks; delete from chunks_fts; delete from docs; delete from containers;')
    this.setMeta('model', model)
    this.cache = null
    return true
  }

  /** @returns {Map<string, { kind: string, stamp: string }>} */
  containers () {
    const rows = /** @type {{ key: string, kind: string, stamp: string }[]} */ (this.db.prepare('select key, kind, stamp from containers').all())
    return new Map(rows.map(r => [r.key, { kind: r.kind, stamp: r.stamp }]))
  }

  /** @param {string} key @param {string} kind @param {string} stamp */
  setContainer (key, kind, stamp) {
    this.db.prepare('insert into containers (key, kind, stamp) values (?, ?, ?) on conflict(key) do update set kind = excluded.kind, stamp = excluded.stamp').run(key, kind, stamp)
  }

  /** @param {string} container @returns {Map<string, string>} key → versión */
  docsOf (container) {
    const rows = /** @type {{ key: string, version: string }[]} */ (this.db.prepare('select key, version from docs where container = ?').all(container))
    return new Map(rows.map(r => [r.key, r.version]))
  }

  /**
   * Reemplaza los trozos de un documento, en una transacción.
   * @param {string} container
   * @param {string} kind
   * @param {import('./sources.js').Doc} doc
   * @param {Float32Array[]} vecs
   */
  putDoc (container, kind, doc, vecs) {
    this.#tx(() => {
      this.#deleteChunks(doc.key)
      const ins = this.db.prepare('insert into chunks (doc, path, kind, date, heading, line, text, vec) values (?, ?, ?, ?, ?, ?, ?, ?)')
      const fts = this.db.prepare('insert into chunks_fts (rowid, heading, text) values (?, ?, ?)')
      doc.chunks.forEach((c, i) => {
        const v = vecs[i]
        const r = ins.run(doc.key, doc.path, kind, doc.date, c.heading, c.line, c.text, new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
        fts.run(r.lastInsertRowid, c.heading, c.text)
      })
      this.db.prepare('insert into docs (key, container, version) values (?, ?, ?) on conflict(key) do update set container = excluded.container, version = excluded.version').run(doc.key, container, doc.version)
    })
  }

  /** @param {string} key */
  removeDoc (key) {
    this.#tx(() => {
      this.#deleteChunks(key)
      this.db.prepare('delete from docs where key = ?').run(key)
    })
  }

  /** @param {string} key */
  removeContainer (key) {
    for (const d of this.docsOf(key).keys()) this.removeDoc(d)
    this.db.prepare('delete from containers where key = ?').run(key)
  }

  /** Devuelve al disco el espacio de lo borrado. */
  compact () {
    this.db.exec('pragma incremental_vacuum; pragma wal_checkpoint(truncate);')
  }

  /** @param {() => void} fn */
  #tx (fn) {
    this.db.exec('begin')
    try { fn(); this.db.exec('commit') } catch (e) { this.db.exec('rollback'); throw e }
    this.cache = null
  }

  /** @param {string} doc */
  #deleteChunks (doc) {
    this.db.prepare('delete from chunks_fts where rowid in (select id from chunks where doc = ?)').run(doc)
    this.db.prepare('delete from chunks where doc = ?').run(doc)
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
   * @returns {number[]}
   */
  lexical (match, limit) {
    if (!match) return []
    const rows = /** @type {{ rowid: number }[]} */ (this.db.prepare('select rowid from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?').all(match, limit))
    return rows.map(r => r.rowid)
  }

  /** @param {number[]} ids @returns {ChunkRow[]} */
  chunksById (ids) {
    if (!ids.length) return []
    const rows = /** @type {ChunkRow[]} */ (this.db.prepare(`select id, path, kind, date, heading, line, text from chunks where id in (${ids.map(() => '?').join(',')})`).all(...ids))
    const byId = new Map(rows.map(r => [r.id, r]))
    return /** @type {ChunkRow[]} */ (ids.map(id => byId.get(id)).filter(Boolean))
  }

  stats () {
    const one = (/** @type {string} */ sql) => /** @type {{ n: number }} */ (this.db.prepare(sql).get()).n
    const byKind = /** @type {{ kind: string, n: number }[]} */ (this.db.prepare('select kind, count(*) n from chunks group by kind').all())
    return {
      sources: one('select count(*) n from containers'),
      chunks: one('select count(*) n from chunks'),
      byKind: Object.fromEntries(byKind.map(r => [r.kind, r.n])),
      model: this.getMeta('model'),
      indexedAt: this.getMeta('indexedAt'),
      skipped: JSON.parse(this.getMeta('skipped') || '[]')
    }
  }

  close () { this.db.close() }
}
