import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CACHE_QUOTA_BYTES,
  CACHE_TTL_MS,
  cacheLifecycle,
  CacheLifecycle,
  scheduleCacheCleanup,
  temporaryCachePath,
} from "../lib/core/cache-lifecycle.js"
import { ExpiringLimitedMap } from "../lib/core/cache.js"
import { config, configPath, reloadConfig, saveConfig } from "../lib/core/config.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })
import { ffmpeg } from "../lib/core/ffmpeg.js"

async function fixture(callback) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-parser-cache-"))
  try {
    return await callback(root)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

async function write(root, name, size, mtimeMs) {
  const target = path.join(root, name)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, Buffer.alloc(size, 1))
  const date = new Date(mtimeMs)
  await fs.promises.utimes(target, date, date)
  return target
}

async function exists(target) {
  try {
    await fs.promises.access(target)
    return true
  } catch {
    return false
  }
}

test("缓存清理递归应用 24h TTL、临时文件 TTL，并保护活动文件", async () => {
  await fixture(async root => {
    const now = Date.now()
    const old = await write(root, "nested/old.bin", 7, now - CACHE_TTL_MS - 1000)
    const active = await write(root, "nested/active.bin", 9, now - CACHE_TTL_MS - 1000)
    const fresh = await write(root, "fresh.bin", 11, now - 1000)
    const temporary = await write(root, "failed.part-123.mp4", 13, now - 2 * 60 * 60 * 1000)
    await fs.promises.mkdir(path.join(root, "empty/child"), { recursive: true })
    const lifecycle = new CacheLifecycle(root, { minIntervalMs: 0 })
    const release = lifecycle.protect(active)
    const report = await lifecycle.cleanup({ force: true, now, quotaBytes: CACHE_QUOTA_BYTES })

    assert.equal(await exists(old), false)
    assert.equal(await exists(temporary), false)
    assert.equal(await exists(active), true)
    assert.equal(await exists(fresh), true)
    assert.equal(await exists(path.join(root, "empty")), false)
    assert.equal(report.deletedFiles, 2)
    assert.equal(report.reasons.expired, 1)
    assert.equal(report.reasons.temporary, 1)
    assert.ok(report.removedDirectories >= 2)

    release()
    release()
    await lifecycle.cleanup({ force: true, now, quotaBytes: CACHE_QUOTA_BYTES })
    assert.equal(await exists(active), false)
  })
})

test("1GiB 配额策略按最旧优先淘汰且跳过活动文件", async () => {
  await fixture(async root => {
    const now = Date.now()
    const lifecycle = new CacheLifecycle(root, { minIntervalMs: 0 })
    const active = await write(root, "a.bin", 6, now - 3000)
    const middle = await write(root, "b.bin", 6, now - 2000)
    const newest = await write(root, "c.bin", 6, now - 1000)
    const release = lifecycle.protect(active)
    const report = await lifecycle.cleanup({
      force: true,
      now,
      ttlMs: CACHE_TTL_MS,
      quotaBytes: 10,
    })

    assert.equal(await exists(active), true)
    assert.equal(await exists(middle), false)
    assert.equal(await exists(newest), false)
    assert.equal(report.reasons.quota, 2)
    assert.equal(report.remainingBytes, 6)
    release()
  })
})

test("解析触发清理受频率限制，临时文件路径保留扩展名", async () => {
  await fixture(async root => {
    const lifecycle = new CacheLifecycle(root, { minIntervalMs: 5000 })
    const first = await lifecycle.cleanup({ now: 10000 })
    const second = await lifecycle.cleanup({ now: 12000 })
    const third = await lifecycle.cleanup({ now: 16000 })
    assert.equal(first.skipped, false)
    assert.deepEqual(second, { skipped: true, reason: "rate-limited" })
    assert.equal(third.skipped, false)

    const temporary = temporaryCachePath(path.join(root, "video.mp4"))
    assert.equal(path.extname(temporary), ".mp4")
    assert.match(path.basename(temporary), /^video\.part-/)
  })
})

test("删除前重新检查活动引用，避免 lstat/unlink 竞态", async () => {
  await fixture(async root => {
    const now = Date.now()
    const target = await write(root, "race.bin", 5, now - CACHE_TTL_MS - 1000)
    const lifecycle = new CacheLifecycle(root, { minIntervalMs: 0 })
    const originalLstat = fs.promises.lstat
    let targetLstatCalls = 0
    let reachedSecondLstat
    let continueSecondLstat
    const secondLstatReached = new Promise(resolve => {
      reachedSecondLstat = resolve
    })
    const secondLstatGate = new Promise(resolve => {
      continueSecondLstat = resolve
    })
    let release

    try {
      fs.promises.lstat = async filePath => {
        const stat = await originalLstat(filePath)
        if (path.resolve(filePath) === path.resolve(target) && ++targetLstatCalls === 2) {
          reachedSecondLstat()
          await secondLstatGate
        }
        return stat
      }

      const cleanup = lifecycle.cleanup({ force: true, now, quotaBytes: CACHE_QUOTA_BYTES })
      await secondLstatReached
      release = lifecycle.protect(target)
      continueSecondLstat()
      await cleanup
      assert.equal(await exists(target), true)
    } finally {
      fs.promises.lstat = originalLstat
      release?.()
    }
  })
})

test("全局清理任务实时读取缓存保留时间和容量配置", async () => {
  const previousCleanup = cacheLifecycle.cleanup
  const previousHours = config.parser_cache_retention_hours
  const previousSize = config.parser_cache_max_mb
  let received
  try {
    config.parser_cache_retention_hours = 2
    config.parser_cache_max_mb = 3
    cacheLifecycle.cleanup = async options => {
      received = options
      return { skipped: false }
    }
    await scheduleCacheCleanup({ reason: "fixture" })
    assert.equal(received.ttlMs, 2 * 60 * 60 * 1000)
    assert.equal(received.quotaBytes, 3 * 1024 * 1024)
    assert.equal(received.reason, "fixture")
  } finally {
    cacheLifecycle.cleanup = previousCleanup
    config.parser_cache_retention_hours = previousHours
    config.parser_cache_max_mb = previousSize
  }
})

test("ExpiringLimitedMap 到期边界正确且 has 保留 Map 的 undefined 语义", () => {
  const originalNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const cache = new ExpiringLimitedMap(2, 100)
    cache.set("value", 1)
    now = 1099
    assert.equal(cache.get("value"), 1)
    now = 1100
    assert.equal(cache.has("value"), false)
    assert.equal(cache.size, 0)
    cache.set("undefined", undefined)
    assert.equal(cache.has("undefined"), true)
    assert.equal(cache.get("undefined"), undefined)
  } finally {
    Date.now = originalNow
  }
})

test("缓存 TTL 或容量热更新会绕过解析限频立即强制清理", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-cache-config-"))
  const temporaryConfig = path.join(directory, "config.yaml")
  const previousCleanup = cacheLifecycle.cleanup
  const calls = []
  try {
    cacheLifecycle.cleanup = async options => {
      calls.push(options)
      return { skipped: false }
    }
    saveConfig(
      {
        parser_cache_retention_hours: config.parser_cache_retention_hours + 1,
        parser_cache_max_mb: config.parser_cache_max_mb + 1,
      },
      temporaryConfig,
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].force, true)
    assert.equal(calls[0].reason, "config-change")
    assert.equal(calls[0].ttlMs, config.parser_cache_retention_hours * 60 * 60 * 1000)
    assert.equal(calls[0].quotaBytes, config.parser_cache_max_mb * 1024 * 1024)
  } finally {
    reloadConfig(configPath)
    cacheLifecycle.cleanup = previousCleanup
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

test("递归清理不跟随指向缓存目录外的符号链接", async t => {
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "yunzai-parser-outside-"))
  try {
    await fixture(async root => {
      const victim = await write(outside, "keep.bin", 5, Date.now() - CACHE_TTL_MS - 1000)
      try {
        await fs.promises.symlink(outside, path.join(root, "outside-link"), "junction")
      } catch (error) {
        if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
          t.skip("当前系统不允许创建测试符号链接")
          return
        }
        throw error
      }
      const lifecycle = new CacheLifecycle(root, { minIntervalMs: 0 })
      await lifecycle.cleanup({ force: true, now: Date.now() })
      assert.equal(await exists(victim), true)
    })
  } finally {
    await fs.promises.rm(outside, { recursive: true, force: true })
  }
})

test("FFmpeg 转换使用临时输出原子发布，并删除失败产物", async () => {
  await fixture(async root => {
    const input = await write(root, "source.mp4", 3, Date.now())
    const output = path.join(root, "source.gif")
    const originalRun = ffmpeg.run
    let temporary
    try {
      ffmpeg.run = async args => {
        temporary = args.at(-1)
        assert.notEqual(temporary, output)
        assert.match(path.basename(temporary), /^source\.part-/)
        await fs.promises.writeFile(temporary, "gif")
      }
      assert.equal(await ffmpeg.toGif(input), output)
      assert.equal(await fs.promises.readFile(output, "utf8"), "gif")
      assert.equal(await exists(temporary), false)

      await fs.promises.unlink(output)
      ffmpeg.run = async args => {
        temporary = args.at(-1)
        await fs.promises.writeFile(temporary, "partial")
        throw new Error("fixture failure")
      }
      await assert.rejects(ffmpeg.toGif(input), /fixture failure/)
      assert.equal(await exists(output), false)
      assert.equal(await exists(temporary), false)
    } finally {
      ffmpeg.run = originalRun
    }
  })
})

let failures = 0
for (const item of tests) {
  let skipped = false
  const context = {
    skip(message) {
      skipped = true
      console.log("- " + item.name + " (" + message + ")")
    },
  }
  try {
    await item.fn(context)
    if (!skipped) console.log("✓ " + item.name)
  } catch (error) {
    failures += 1
    console.error("✗ " + item.name)
    console.error(error)
  }
}

console.log("\n" + (tests.length - failures) + "/" + tests.length + " tests passed")
if (failures) process.exitCode = 1
