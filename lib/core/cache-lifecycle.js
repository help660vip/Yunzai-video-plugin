import fs from "node:fs"
import path from "node:path"

import { config, onConfigChange } from "./config.js"
import { log } from "./logger.js"
import { cacheDir } from "./paths.js"

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const CACHE_QUOTA_BYTES = 1024 * 1024 * 1024
export const TEMP_FILE_TTL_MS = 60 * 60 * 1000
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000

function normalized(filePath) {
  const value = path.resolve(filePath)
  return process.platform === "win32" ? value.toLowerCase() : value
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
}

function isTemporary(filePath) {
  const name = path.basename(filePath).toLowerCase()
  return name.includes(".part-") || name.endsWith(".part") || name.endsWith(".tmp") || name.endsWith(".failed")
}

async function lstatOrNull(filePath) {
  try {
    return await fs.promises.lstat(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export function temporaryCachePath(target) {
  const parsed = path.parse(target)
  const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2)
  return path.join(parsed.dir, parsed.name + ".part-" + token + parsed.ext)
}

export class CacheLifecycle {
  constructor(root = cacheDir, { minIntervalMs = CLEANUP_INTERVAL_MS } = {}) {
    this.root = path.resolve(root)
    if (this.root === path.parse(this.root).root) {
      throw new Error("拒绝将文件系统根目录作为缓存目录")
    }
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0)
    this.active = new Map()
    this.lastCleanupAt = 0
    this.cleanupPromise = null
  }

  isActive(filePath) {
    return (this.active.get(normalized(filePath)) || 0) > 0
  }

  protect(paths) {
    const values = [...new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(normalized))]
    for (const value of values) this.active.set(value, (this.active.get(value) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const value of values) {
        const count = (this.active.get(value) || 0) - 1
        if (count > 0) this.active.set(value, count)
        else this.active.delete(value)
      }
    }
  }

  async withActive(paths, callback) {
    const release = this.protect(paths)
    try {
      return await callback()
    } finally {
      release()
    }
  }

  async touch(filePath) {
    if (!isWithin(this.root, path.resolve(filePath))) return false
    try {
      const now = new Date()
      await fs.promises.utimes(filePath, now, now)
      return true
    } catch {
      return false
    }
  }

  async scan(report) {
    const files = []
    const directories = []
    const visit = async directory => {
      let entries
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code !== "ENOENT") report.errors.push({ path: directory, code: error?.code || "READ_FAILED" })
        return
      }
      for (const entry of entries) {
        const candidate = path.resolve(directory, entry.name)
        if (!isWithin(this.root, candidate)) continue
        let stat
        try {
          stat = await fs.promises.lstat(candidate)
        } catch (error) {
          if (error?.code !== "ENOENT") report.errors.push({ path: candidate, code: error?.code || "STAT_FAILED" })
          continue
        }
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          await visit(candidate)
          directories.push(candidate)
        } else if (stat.isFile()) {
          files.push({ path: candidate, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      }
    }
    await visit(this.root)
    return { files, directories }
  }

  async removeFile(entry, report, reason) {
    if (this.isActive(entry.path)) return false
    try {
      const stat = await lstatOrNull(entry.path)
      if (!stat) return true
      if (!stat.isFile() || stat.isSymbolicLink()) return false
      if (stat.mtimeMs > entry.mtimeMs) return false
      if (this.isActive(entry.path)) return false
      await fs.promises.unlink(entry.path)
      report.deletedFiles += 1
      report.deletedBytes += entry.size
      report.reasons[reason] += 1
      return true
    } catch (error) {
      report.errors.push({ path: entry.path, code: error?.code || "DELETE_FAILED" })
      return false
    }
  }

  async cleanup({
    force = false,
    reason = "scheduled",
    now = Date.now(),
    ttlMs = CACHE_TTL_MS,
    quotaBytes = CACHE_QUOTA_BYTES,
    tempTtlMs = TEMP_FILE_TTL_MS,
  } = {}) {
    if (this.cleanupPromise) return this.cleanupPromise
    if (!force && this.lastCleanupAt > 0 && now - this.lastCleanupAt < this.minIntervalMs) {
      return { skipped: true, reason: "rate-limited" }
    }
    this.lastCleanupAt = now
    this.cleanupPromise = this.cleanupInternal({ reason, now, ttlMs, quotaBytes, tempTtlMs })
    try {
      return await this.cleanupPromise
    } finally {
      this.cleanupPromise = null
    }
  }

  async cleanupInternal({ reason, now, ttlMs, quotaBytes, tempTtlMs }) {
    await fs.promises.mkdir(this.root, { recursive: true })
    const report = {
      skipped: false,
      reason,
      scannedFiles: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      remainingBytes: 0,
      removedDirectories: 0,
      reasons: { expired: 0, temporary: 0, quota: 0 },
      errors: [],
    }
    const { files, directories } = await this.scan(report)
    report.scannedFiles = files.length
    let remainingBytes = files.reduce((total, entry) => total + entry.size, 0)
    const retained = []
    for (const entry of files) {
      const temporary = isTemporary(entry.path)
      const maxAge = temporary ? tempTtlMs : ttlMs
      const expired = maxAge >= 0 && now - entry.mtimeMs >= maxAge
      if (expired && !this.isActive(entry.path)) {
        const removed = await this.removeFile(entry, report, temporary ? "temporary" : "expired")
        if (removed) {
          remainingBytes -= entry.size
          continue
        }
      }
      retained.push(entry)
    }
    if (remainingBytes > quotaBytes) {
      retained.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
      for (const entry of retained) {
        if (remainingBytes <= quotaBytes) break
        if (this.isActive(entry.path)) continue
        if (await this.removeFile(entry, report, "quota")) remainingBytes -= entry.size
      }
    }
    for (const directory of directories) {
      if (this.isActive(directory)) continue
      try {
        await fs.promises.rmdir(directory)
        report.removedDirectories += 1
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
          report.errors.push({ path: directory, code: error?.code || "RMDIR_FAILED" })
        }
      }
    }
    report.remainingBytes = Math.max(0, remainingBytes)
    return report
  }
}

export const cacheLifecycle = new CacheLifecycle(cacheDir)

export function scheduleCacheCleanup(options = {}) {
  const configured = {
    ttlMs: config.parser_cache_retention_hours * 60 * 60 * 1000,
    quotaBytes: config.parser_cache_max_mb * 1024 * 1024,
    ...options,
  }
  return cacheLifecycle.cleanup(configured).catch(error => {
    log.warn("[parser] 缓存清理失败", error)
    return { skipped: false, reason: configured.reason || "scheduled", error }
  })
}

onConfigChange((next, previous) => {
  if (
    next.parser_cache_retention_hours === previous.parser_cache_retention_hours &&
    next.parser_cache_max_mb === previous.parser_cache_max_mb
  ) {
    return
  }
  const run = () => {
    void scheduleCacheCleanup({ force: true, reason: "config-change" })
  }
  if (cacheLifecycle.cleanupPromise) {
    cacheLifecycle.cleanupPromise.finally(run).catch(() => {})
  } else {
    run()
  }
})
