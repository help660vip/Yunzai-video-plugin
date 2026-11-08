import fs from "node:fs"
import path from "node:path"

import { cacheDir } from "./paths.js"

const TRANSIENT = /(?:\.part(?:-|\.)|\.(?:part|tmp|failed)$)/i

// Disk paths remain relative to the cache root. Metadata never supplies a path
// to read or delete; it only describes the payload found by the safe tree scan.
export class CacheIndex {
  constructor(root = cacheDir) {
    this.root = path.resolve(root)
    this.entries = new Map()
    this.ready = null
    this.writes = new Map()
  }

  contains(file) {
    const relative = path.relative(this.root, path.resolve(file))
    return Boolean(relative) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  }

  key(file) {
    const parsed = path.parse(path.resolve(file))
    const key = path.join(parsed.dir, parsed.name)
    return process.platform === "win32" ? key.toLowerCase() : key
  }

  async safePath(file) {
    let candidate = path.resolve(file)
    if (candidate !== this.root && !this.contains(candidate)) return false
    while (true) {
      try { if ((await fs.promises.lstat(candidate)).isSymbolicLink()) return false }
      catch (error) { if (error.code !== "ENOENT") throw error }
      if (candidate === this.root) return true
      candidate = path.dirname(candidate)
    }
  }

  async warmup() {
    if (!this.ready) this.ready = this.scan().catch(error => { this.ready = null; throw error })
    return this.ready
  }

  async scan() {
    const pending = [this.root]
    let count = 0
    while (pending.length) {
      const directory = pending.pop()
      if (!await this.safePath(directory)) continue
      let entries
      try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) }
      catch (error) { if (error.code === "ENOENT") continue; throw error }
      for (const entry of entries) {
        const file = path.join(directory, entry.name)
        if (!this.contains(file) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { pending.push(file); continue }
        if (!entry.isFile() || entry.name.endsWith(".meta") || TRANSIENT.test(entry.name)) continue
        try {
          const stat = await fs.promises.lstat(file)
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          const key = this.key(file)
          let meta = {}
          try { meta = JSON.parse(await fs.promises.readFile(key + ".meta", "utf8")) || {} } catch {}
          const stored = Number(meta.lastHit)
          const lastHit = Math.min(Date.now(), Math.max(stat.mtimeMs, Number.isFinite(stored) ? stored : 0))
          const value = { path: file, size: stat.size, lastHit, persistedHit: lastHit, extra: meta.extra && typeof meta.extra === "object" ? meta.extra : {} }
          const previous = this.entries.get(key)
          if (!previous || previous.lastHit < lastHit) this.entries.set(key, value)
          count++
        } catch (error) { if (error.code !== "ENOENT") throw error }
      }
    }
    return count
  }

  async get(file) {
    if (!this.contains(file)) return null
    await this.warmup()
    const key = this.key(file)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (!await this.safePath(entry.path)) { this.entries.delete(key); return null }
    try {
      const stat = await fs.promises.lstat(entry.path)
      if (!stat.isFile() || stat.isSymbolicLink()) { this.entries.delete(key); return null }
      entry.size = stat.size
    } catch (error) { if (error.code === "ENOENT") { this.entries.delete(key); return null }; throw error }
    entry.lastHit = Date.now()
    return entry
  }

  peek(file) {
    if (!this.contains(file)) return null
    const entry = this.entries.get(this.key(file))
    return entry?.path === path.resolve(file) ? entry : null
  }

  touch(file, now = Date.now()) {
    const entry = this.peek(file)
    if (!entry) return false
    entry.lastHit = now
    return true
  }

  async set(file, extra = {}) {
    if (!this.contains(file) || TRANSIENT.test(path.basename(file))) return null
    if (!await this.safePath(file)) return null
    await this.warmup()
    const stat = await fs.promises.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const key = this.key(file)
    const entry = { path: path.resolve(file), size: stat.size, lastHit: Date.now(), persistedHit: 0, extra }
    this.entries.set(key, entry)
    await this.persist(key, entry)
    return entry
  }

  persist(key, entry) {
    const previous = this.writes.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      if (this.entries.get(key) !== entry) return
      const temporary = key + ".meta." + process.pid + ".tmp"
      const hit = entry.lastHit
      try {
        await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, suffix: path.extname(entry.path), size: entry.size, lastHit: hit, extra: entry.extra }), { flag: "w", mode: 0o600 })
        await fs.promises.rename(temporary, key + ".meta")
        entry.persistedHit = hit
      } finally { await fs.promises.unlink(temporary).catch(() => {}) }
    }).finally(() => { if (this.writes.get(key) === pending) this.writes.delete(key) })
    this.writes.set(key, pending)
    return pending
  }

  async flush(minIntervalMs = 60000) {
    await this.warmup()
    for (const [key, entry] of this.entries) {
      if (entry.lastHit - entry.persistedHit >= minIntervalMs) await this.persist(key, entry)
    }
  }

  async remove(file) {
    const entry = this.peek(file)
    if (!entry) return
    const key = this.key(file)
    this.entries.delete(key)
    await this.writes.get(key)?.catch(() => {})
    await fs.promises.unlink(key + ".meta").catch(() => {})
  }
}

export const cacheIndex = new CacheIndex()
