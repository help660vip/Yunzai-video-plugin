import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { cacheLifecycle, temporaryCachePath } from "./cache-lifecycle.js"
import { config, onConfigChange } from "./config.js"
import { ParseError, IgnoreError } from "./errors.js"
import { cacheDir, configDir } from "./paths.js"
import { LimitedMap } from "./cache.js"
import { commandExists, parseCookieString, runProcess, safeUnlink } from "./utils.js"

export const hasYtDlp = commandExists("yt-dlp")

const infoCache = new LimitedMap(50)
const locks = new Map()

function withLock(url, callback) {
  const previous = locks.get(url) || Promise.resolve()
  const current = previous.catch(() => {}).then(callback)
  locks.set(url, current)
  current.finally(() => {
    if (locks.get(url) === current) locks.delete(url)
  })
  return current
}

async function publishTemporary(temporary, target) {
  try {
    await fs.promises.rename(temporary, target)
  } catch (error) {
    if (!fs.existsSync(target)) throw error
    await safeUnlink(temporary)
  }
  await cacheLifecycle.touch(target)
  return target
}

async function enforceConfiguredSize(filePath) {
  const stat = await fs.promises.stat(filePath)
  const maximum = config.parser_max_size * 1024 * 1024
  if (stat.size <= maximum) return
  await safeUnlink(filePath)
  throw new IgnoreError("Downloaded media exceeds the configured size limit")
}

async function cachedDownload(target, callback) {
  if (fs.existsSync(target)) {
    await enforceConfiguredSize(target)
    await cacheLifecycle.touch(target)
    return target
  }
  const temporary = temporaryCachePath(target)
  return cacheLifecycle.withActive([target, temporary], async () => {
    try {
      await callback(temporary)
      await enforceConfiguredSize(temporary)
      return await publishTemporary(temporary, target)
    } catch (error) {
      await safeUnlink(temporary)
      throw error
    }
  })
}

export function writeNetscapeCookies(cookieString, fileName, domain) {
  if (!cookieString) return null
  const filePath = path.join(configDir, fileName)
  const lines = ["# Netscape HTTP Cookie File"]
  for (const [name, value] of Object.entries(parseCookieString(cookieString))) {
    lines.push(`.${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`)
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8")
  return filePath
}

function commonArgs(cookieFile) {
  const args = []
  if (config.parser_proxy) args.push("--proxy", config.parser_proxy)
  if (cookieFile) args.push("--cookies", cookieFile)
  return args
}

export function buildInfoArgs(url, cookieFile = null) {
  return [
    "--dump-single-json",
    "--skip-download",
    "--quiet",
    "--no-warnings",
    ...commonArgs(cookieFile),
    url,
  ]
}

function normalizeInfo(raw) {
  const uploadDate = raw.timestamp
    ? Number(raw.timestamp)
    : raw.upload_date
      ? Math.floor(
          Date.UTC(
            Number(raw.upload_date.slice(0, 4)),
            Number(raw.upload_date.slice(4, 6)) - 1,
            Number(raw.upload_date.slice(6, 8)),
          ) / 1000,
        )
      : null
  return {
    id: raw.id || "",
    title: raw.title || "",
    channel: raw.channel || raw.uploader || "",
    uploader: raw.uploader_id || raw.uploader || "",
    duration: Number(raw.duration || 0),
    timestamp: uploadDate,
    thumbnail: raw.thumbnail || "",
    description: raw.description || "",
    channelId: raw.channel_id || raw.uploader_id || "",
    ageLimit: Number(raw.age_limit || 0),
    availability: raw.availability || "",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    webpageUrl: raw.webpage_url || raw.original_url || "",
    authorName: `${raw.channel || raw.uploader || ""}@${raw.uploader_id || raw.uploader || ""}`,
  }
}

onConfigChange((next, previous) => {
  if (
    next.parser_proxy !== previous.parser_proxy ||
    next.parser_ytb_ck !== previous.parser_ytb_ck
  ) {
    infoCache.clear()
  }
})

export const ytdlp = {
  async extractInfo(url, cookieFile = null) {
    const cached = infoCache.get(url)
    if (cached) return cached
    if (!hasYtDlp) throw new ParseError("未安装 yt-dlp")
    const { stdout } = await runProcess("yt-dlp", buildInfoArgs(url, cookieFile))
    const line = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop()
    if (!line) throw new ParseError("获取视频信息失败")
    const info = normalizeInfo(JSON.parse(line))
    infoCache.set(url, info)
    return info
  },

  async downloadVideo(url, cookieFile = null) {
    const info = await this.extractInfo(url, cookieFile)
    if (info.duration > config.parser_duration_maximum) {
      throw new IgnoreError("视频时长超过限制")
    }
    const target = path.join(
      cacheDir,
      `${crypto.createHash("md5").update(url).digest("hex").slice(0, 16)}.mp4`,
    )
    return withLock(url, async () => {
      return cachedDownload(target, async temporary => {
        const videoLimit = Math.floor(info.duration / 10) + 10
        const mergedLimit = Math.floor(info.duration / 8) + 10
        await runProcess("yt-dlp", [
          "-f",
          `bv[filesize<=${videoLimit}M]+ba/b[filesize<=${mergedLimit}M]`,
          "--merge-output-format",
          "mp4",
          "--recode-video",
          "mp4",
          "-o",
          temporary,
          ...commonArgs(cookieFile),
          url,
        ])
      })
    })
  },

  async downloadAudio(url, cookieFile = null) {
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 16)
    const target = path.join(cacheDir, `${hash}.flac`)
    return withLock(url, async () => {
      return cachedDownload(target, async temporary => {
        await runProcess("yt-dlp", [
          "-f",
          "bestaudio/best",
          "-x",
          "--audio-format",
          "flac",
          "--audio-quality",
          "0",
          "-o",
          temporary,
          ...commonArgs(cookieFile),
          url,
        ])
      })
    })
  },
}
