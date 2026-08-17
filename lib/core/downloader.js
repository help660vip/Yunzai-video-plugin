import fs from "node:fs"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { gotScraping } from "got-scraping"

import { cacheLifecycle, temporaryCachePath } from "./cache-lifecycle.js"
import { config } from "./config.js"
import { DownloadError, IgnoreError } from "./errors.js"
import { ffmpeg } from "./ffmpeg.js"
import { HttpClient } from "./http.js"
import { cacheDir } from "./paths.js"
import { COMMON_HEADERS, md5Name, safeUnlink } from "./utils.js"
import { log } from "./logger.js"

function validateLength(headers, url) {
  const raw =
    typeof headers.get === "function" ? headers.get("content-length") : headers["content-length"]
  if (raw === null || raw === undefined || raw === "") return null
  const length = Number(raw)
  if (!Number.isFinite(length) || length <= 0) {
    log.warn(`[parser] 媒体 url: ${url}, 大小为 0, 取消下载`)
    throw new IgnoreError("媒体 Content-Length 为 0")
  }
  const sizeMb = length / 1024 / 1024
  if (sizeMb > config.parser_max_size) {
    log.warn(
      `[parser] 媒体 url: ${url} 大小 ${sizeMb.toFixed(2)} MB, 超过 ${config.parser_max_size} MB`,
    )
    throw new IgnoreError("媒体文件过大")
  }
  return length
}

const FORMAT_EXTENSIONS = Object.freeze({
  image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"],
  audio: [".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wav", ".opus"],
  video: [".mp4", ".flv", ".webm", ".ts", ".mov", ".mkv", ".ogv"],
})
const SIZE_MISMATCH_TOLERANCE = 1024

function headerValue(headers, name) {
  return typeof headers?.get === "function" ? headers.get(name) : headers?.[name]
}

function expectedLength(headers, existing = 0) {
  const range = headerValue(headers, "content-range")
  const total = /\/(\d+)$/.exec(String(range || ""))?.[1]
  if (total) return Number(total)
  const length = Number(headerValue(headers, "content-length") || 0)
  return Number.isFinite(length) && length > 0 ? existing + length : null
}

function lengthMatches(actual, expected) {
  return expected === null || Math.abs(Number(actual) - Number(expected)) <= SIZE_MISMATCH_TOLERANCE
}

function sizeLimiter(existing = 0) {
  let received = 0
  const maximum = config.parser_max_size * 1024 * 1024
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      const baseSize = typeof existing === "function" ? existing() : existing
      if (baseSize + received > maximum) {
        callback(new IgnoreError("媒体文件过大"))
        return
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (received === 0) callback(new IgnoreError("媒体文件为空"))
      else callback()
    },
  })
}

function detectedExtension(buffer, contentType = "", kind = null) {
  const type = String(contentType).toLowerCase().split(";", 1)[0]
  if (buffer.length >= 12) {
    const ascii = buffer.toString("ascii", 0, Math.min(buffer.length, 16))
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg"
    if (
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      return ".png"
    }
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return ".gif"
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return ".webp"
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return ".wav"
    if (ascii.startsWith("fLaC")) return ".flac"
    if (ascii.startsWith("OggS")) return kind === "video" ? ".ogv" : ".ogg"
    if (ascii.startsWith("ID3") || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
      return kind === "audio" ? ".mp3" : null
    }
    if (ascii.startsWith("FLV")) return ".flv"
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
      return kind === "audio" ? ".opus" : ".webm"
    }
    if (ascii.slice(4, 8) === "ftyp") {
      const brand = ascii.slice(8, 12).toLowerCase()
      if (brand === "avif" || brand === "avis") return ".avif"
      if (kind === "audio" || ["m4a ", "m4b ", "f4a "].includes(brand)) return ".m4a"
      if (brand === "qt  ") return ".mov"
      return ".mp4"
    }
    if (buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47)) return ".ts"
  }
  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "audio/mpeg": ".mp3",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/x-flv": ".flv",
    "video/webm": ".webm",
    "video/mp2t": ".ts",
    "video/quicktime": ".mov",
  }
  return byType[type] || null
}

async function detectFileExtension(filePath, contentType, kind) {
  const handle = await fs.promises.open(filePath, "r")
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return detectedExtension(buffer.subarray(0, bytesRead), contentType, kind)
  } finally {
    await handle.close()
  }
}

export class StreamDownloader {
  constructor() {
    this.http = new HttpClient({ headers: COMMON_HEADERS, timeout: 240000, verify: false })
    this.inFlight = new Map()
  }

  async publishTemporary(temporary, target) {
    try {
      await fs.promises.rename(temporary, target)
    } catch (error) {
      if (!fs.existsSync(target)) throw error
      await safeUnlink(temporary)
    }
    await cacheLifecycle.touch(target)
    return target
  }

  async forTarget(target, callback) {
    if (fs.existsSync(target)) {
      await cacheLifecycle.touch(target)
      return target
    }
    const existing = this.inFlight.get(target)
    if (existing) return existing
    const pending = Promise.resolve().then(callback).finally(() => this.inFlight.delete(target))
    this.inFlight.set(target, pending)
    return pending
  }

  async download(
    url,
    {
      fileName = null,
      suffix = "",
      headers = {},
      chunkSize = 65536,
      cacheKey = null,
      browser = false,
      detectFormat = null,
    } = {},
  ) {
    const target = path.join(cacheDir, fileName || md5Name(cacheKey || url, suffix))
    if (!fileName && detectFormat) {
      const parsed = path.parse(target)
      for (const extension of FORMAT_EXTENSIONS[detectFormat] || []) {
        const candidate = path.join(parsed.dir, parsed.name + extension)
        if (fs.existsSync(candidate)) {
          await cacheLifecycle.touch(candidate)
          return candidate
        }
      }
    }
    return this.forTarget(target, () =>
      this.downloadManaged(url, target, { headers, chunkSize, browser, detectFormat, fileName }),
    )
  }

  async downloadManaged(url, target, { headers, chunkSize, browser, detectFormat, fileName }) {
    const temporary = temporaryCachePath(target)
    return cacheLifecycle.withActive([target, temporary], async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })

      let lastError
      for (let attempt = 0; attempt <= config.parser_max_retries; attempt += 1) {
        try {
          const metadata = await this.downloadOnce(url, temporary, { headers, chunkSize, browser })
          let finalTarget = target
          if (!fileName && detectFormat) {
            const extension = await detectFileExtension(
              temporary,
              metadata?.contentType,
              detectFormat,
            )
            if (extension) {
              const parsed = path.parse(target)
              finalTarget = path.join(parsed.dir, parsed.name + extension)
            }
          }
          return cacheLifecycle.withActive([finalTarget], () =>
            this.publishTemporary(temporary, finalTarget),
          )
        } catch (error) {
          if (error instanceof IgnoreError) {
            await safeUnlink(temporary)
            throw error
          }
          lastError = error
          if (attempt < config.parser_max_retries) {
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
          }
        }
      }
      await safeUnlink(temporary)
      throw new DownloadError("媒体下载失败: " + (lastError?.message || "未知错误"))
    })
  }

  async downloadOnce(url, target, { headers, chunkSize, browser }) {
    const existing = fs.existsSync(target) ? (await fs.promises.stat(target)).size : 0
    const requestHeaders = {
      ...headers,
      ...(existing > 0 ? { range: "bytes=" + existing + "-" } : {}),
    }
    if (!browser) {
      try {
        const response = await this.http.request(url, {
          headers: requestHeaders,
          timeout: 240000,
          redirect: "follow",
        })
        const append = existing > 0 && response.status === 206
        const baseSize = append ? existing : 0
        const total = expectedLength(response.headers, baseSize)
        validateLength(
          { get: name => name === "content-length" ? total : response.headers.get(name) },
          response.url || url,
        )
        await pipeline(
          response.body,
          sizeLimiter(baseSize),
          fs.createWriteStream(target, {
            flags: append ? "a" : "w",
            highWaterMark: chunkSize,
          }),
        )
        if (!lengthMatches((await fs.promises.stat(target)).size, total)) {
          throw new Error("媒体文件大小校验失败")
        }
        return {
          path: target,
          contentType: response.headers.get("content-type"),
          finalUrl: response.url || url,
        }
      } catch (error) {
        if (error instanceof IgnoreError) throw error
        log.warn(`[parser] node-fetch 下载失败，尝试 got-scraping: ${url}`, error.message)
      }
    }

    const resumed = fs.existsSync(target) ? (await fs.promises.stat(target)).size : 0
    let effectiveExisting = resumed
    const response = gotScraping.stream({
      url,
      headers: {
        ...COMMON_HEADERS,
        ...headers,
        ...(resumed > 0 ? { range: "bytes=" + resumed + "-" } : {}),
      },
      timeout: { request: 240000 },
      followRedirect: true,
    })
    let responseMeta = null
    response.once("response", metadata => {
      try {
        responseMeta = metadata
        const append = resumed > 0 && metadata.statusCode === 206
        if (!append && resumed > 0) {
          fs.truncateSync(target, 0)
          effectiveExisting = 0
        }
        const total = expectedLength(metadata.headers, effectiveExisting)
        validateLength(
          { get: name => name === "content-length" ? total : headerValue(metadata.headers, name) },
          metadata.url || url,
        )
      } catch (error) {
        response.destroy(error)
      }
    })
    await pipeline(
      response,
      sizeLimiter(() => effectiveExisting),
      fs.createWriteStream(target, {
        flags: resumed > 0 ? "a" : "w",
        highWaterMark: chunkSize,
      }),
    )
    const total = expectedLength(responseMeta?.headers, effectiveExisting)
    if (!lengthMatches((await fs.promises.stat(target)).size, total)) {
      throw new Error("媒体文件大小校验失败")
    }
    return {
      path: target,
      contentType: headerValue(responseMeta?.headers, "content-type"),
      finalUrl: responseMeta?.url || url,
    }
  }

  async downloadVideo(url, options = {}) {
    const mediaPath = await this.download(url, {
      suffix: ".mp4",
      chunkSize: 1024 * 1024,
      detectFormat: "video",
      ...options,
    })
    if (path.extname(mediaPath).toLowerCase() === ".mp4") return mediaPath
    const outputPath = path.join(path.dirname(mediaPath), path.parse(mediaPath).name + ".mp4")
    try {
      return await ffmpeg.remuxMp4(mediaPath, outputPath)
    } catch (error) {
      log.warn(`[parser] 视频格式自动修正失败，发送原文件: ${error.message}`)
      return mediaPath
    }
  }

  async downloadAudio(url, options = {}) {
    const mediaPath = await this.download(url, {
      suffix: ".mp3",
      detectFormat: "audio",
      ...options,
    })
    try {
      return await ffmpeg.toMp3(mediaPath)
    } catch (error) {
      log.warn(`[parser] 音频格式自动修正失败，发送原文件: ${error.message}`)
      return mediaPath
    }
  }

  downloadImage(url, options = {}) {
    return this.download(url, { suffix: ".jpg", detectFormat: "image", ...options })
  }

  async content(url, { headers = {}, browser = false } = {}) {
    if (browser) {
      const response = await gotScraping({
        url,
        headers: { ...COMMON_HEADERS, ...headers },
        responseType: "buffer",
        timeout: { request: 240000 },
        followRedirect: true,
      })
      return response.body
    }
    const response = await this.http.request(url, { headers, timeout: 240000 })
    return Buffer.from(await response.arrayBuffer())
  }

  async head(url, { headers = {}, browser = false } = {}) {
    if (browser) {
      const response = await gotScraping({
        url,
        method: "HEAD",
        headers: { ...COMMON_HEADERS, ...headers },
        responseType: "buffer",
        timeout: { request: 30000 },
        followRedirect: true,
      })
      return { url: response.url || url, headers: response.headers, status: response.statusCode }
    }
    const response = await this.http.request(url, {
      method: "HEAD",
      headers,
      timeout: 30000,
    })
    return { url: response.url || url, headers: response.headers, status: response.status }
  }

  async headSize(url, options = {}) {
    const response = await this.head(url, options)
    const value =
      typeof response.headers.get === "function"
        ? response.headers.get("content-length")
        : response.headers["content-length"]
    const size = Number(value || 0)
    return Number.isFinite(size) && size > 0 ? size : null
  }

  async downloadAVAndMerge(videoUrl, audioUrl, { outputPath, headers = {}, h264 = false } = {}) {
    if (fs.existsSync(outputPath)) {
      await cacheLifecycle.touch(outputPath)
      return outputPath
    }
    const [videoPath, audioPath] = await Promise.all([
      this.download(videoUrl, { headers }),
      this.download(audioUrl, { headers }),
    ])
    return h264
      ? ffmpeg.mergeAVH264(videoPath, audioPath, outputPath)
      : ffmpeg.mergeAV(videoPath, audioPath, outputPath)
  }

  async m3u8Slices(url, headers = {}) {
    const text = await this.http.text(url, { headers })
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => new URL(line, url).href)
  }

  async downloadM3u8(url, { fileName = null, headers = {} } = {}) {
    const target = path.join(cacheDir, fileName || md5Name(url, ".mp4"))
    return this.forTarget(target, () => this.downloadM3u8Managed(url, target, headers))
  }

  async downloadM3u8Managed(url, target, headers) {
    const temporary = temporaryCachePath(target)
    return cacheLifecycle.withActive([target, temporary], async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      const output = fs.createWriteStream(temporary)
      try {
        for (const slice of await this.m3u8Slices(url, headers)) {
          const response = await this.http.request(slice, { headers, timeout: 240000 })
          await new Promise((resolve, reject) => {
            response.body.once("error", reject)
            response.body.once("end", resolve)
            response.body.pipe(output, { end: false })
          })
        }
        await new Promise((resolve, reject) => output.end(error => (error ? reject(error) : resolve())))
        return await this.publishTemporary(temporary, target)
      } catch (error) {
        output.destroy()
        await safeUnlink(temporary)
        throw new DownloadError(`m3u8 视频下载失败: ${error.message}`)
      }
    })
  }
}

export const downloader = new StreamDownloader()
