import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { config } from "./config.js"
import { ParseError, IgnoreError } from "./errors.js"
import { cacheDir, configDir } from "./paths.js"
import { LimitedMap } from "./cache.js"
import { commandExists, parseCookieString, runProcess } from "./utils.js"

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
    title: raw.title || "",
    channel: raw.channel || raw.uploader || "",
    uploader: raw.uploader_id || raw.uploader || "",
    duration: Number(raw.duration || 0),
    timestamp: uploadDate,
    thumbnail: raw.thumbnail || "",
    description: raw.description || "",
    channelId: raw.channel_id || raw.uploader_id || "",
    authorName: `${raw.channel || raw.uploader || ""}@${raw.uploader_id || raw.uploader || ""}`,
  }
}

export const ytdlp = {
  async extractInfo(url, cookieFile = null) {
    const cached = infoCache.get(url)
    if (cached) return cached
    if (!hasYtDlp) throw new ParseError("未安装 yt-dlp")
    const { stdout } = await runProcess("yt-dlp", [
      "--dump-single-json",
      "--skip-download",
      "--quiet",
      "--no-warnings",
      "--force-generic-extractor",
      ...commonArgs(cookieFile),
      url,
    ])
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
    if (fs.existsSync(target)) return target
    return withLock(url, async () => {
      if (fs.existsSync(target)) return target
      const videoLimit = Math.floor(info.duration / 10) + 10
      const mergedLimit = Math.floor(info.duration / 8) + 10
      try {
        await runProcess("yt-dlp", [
          "-f",
          `bv[filesize<=${videoLimit}M]+ba/b[filesize<=${mergedLimit}M]`,
          "--merge-output-format",
          "mp4",
          "--recode-video",
          "mp4",
          "-o",
          target,
          ...commonArgs(cookieFile),
          url,
        ])
      } catch (error) {
        if (!fs.existsSync(target)) throw error
      }
      return target
    })
  },

  async downloadAudio(url, cookieFile = null) {
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 16)
    const target = path.join(cacheDir, `${hash}.flac`)
    if (fs.existsSync(target)) return target
    return withLock(url, async () => {
      if (fs.existsSync(target)) return target
      try {
        await runProcess("yt-dlp", [
          "-f",
          "bestaudio/best",
          "-x",
          "--audio-format",
          "flac",
          "--audio-quality",
          "0",
          "-o",
          path.join(cacheDir, `${hash}.%(ext)s`),
          ...commonArgs(cookieFile),
          url,
        ])
      } catch (error) {
        if (!fs.existsSync(target)) throw error
      }
      return target
    })
  },
}
