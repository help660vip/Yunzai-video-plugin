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
const CONTENT_RANGE_PATTERN = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i

class RetryableDownloadError extends Error {
  constructor(message, { keepPartial = true } = {}) {
    super(message)
    this.keepPartial = keepPartial
  }
}

class NonRetryableDownloadError extends Error {}

function errorMessage(error) {
  return error?.message || error?.code || error?.cause?.code || String(error || "未知错误")
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name)
  const wanted = String(name).toLowerCase()
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === wanted)
  return key ? headers[key] : undefined
}

function identityHeaders(headers = {}) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== "accept-encoding") result[key] = value
  }
  result["accept-encoding"] = "identity"
  return result
}

function contentEncodings(headers) {
  return String(headerValue(headers, "content-encoding") || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
}

function compressedResponse(headers) {
  return contentEncodings(headers).some(value => value !== "identity")
}

function validateResponseStatus(status, headers, existing, retryHttpStatuses) {
  if (existing > 0 && status === 416) {
    throw new RetryableDownloadError("断点位置无效，重新完整下载", { keepPartial: false })
  }
  if (retryHttpStatuses.has(status)) {
    throw new RetryableDownloadError(`HTTP ${status}，切换下载线路后重试`, {
      keepPartial: false,
    })
  }
  if (status < 200 || status >= 300) {
    throw new NonRetryableDownloadError(`HTTP ${status}`)
  }
  if (existing <= 0) return
  if (status !== 206) {
    throw new RetryableDownloadError("服务器不支持断点续传", { keepPartial: false })
  }
  const range = String(headerValue(headers, "content-range") || "")
  const match = CONTENT_RANGE_PATTERN.exec(range)
  if (!match) {
    throw new RetryableDownloadError("服务器未返回有效的 Content-Range", {
      keepPartial: false,
    })
  }
  if (Number(match[1]) !== existing) {
    throw new RetryableDownloadError(
      `Content-Range 错误: 请求 ${existing}, 返回 ${match[1]}`,
      { keepPartial: false },
    )
  }
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

function validateDownloadedSize(actual, expected) {
  if (lengthMatches(actual, expected)) return
  const short = expected !== null && Number(actual) < Number(expected)
  throw new RetryableDownloadError(`媒体文件大小校验失败: ${actual}/${expected}`, {
    keepPartial: short,
  })
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
      suffix = ".dat",
      headers = {},
      chunkSize = 65536,
      cacheKey = null,
      browser = false,
      detectFormat = null,
      fallbackUrls = [],
      retryHttpStatuses = [],
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
      this.downloadManaged(url, target, {
        headers,
        chunkSize,
        browser,
        detectFormat,
        fileName,
        fallbackUrls,
        retryHttpStatuses,
      }),
    )
  }

  async downloadManaged(
    url,
    target,
    { headers, chunkSize, browser, detectFormat, fileName, fallbackUrls, retryHttpStatuses },
  ) {
    const temporary = temporaryCachePath(target)
    const downloadUrls = [...new Set([url, ...(fallbackUrls || [])].filter(Boolean))]
    if (!downloadUrls.length) throw new DownloadError("媒体下载失败: URL 为空")
    const retryStatuses = new Set(retryHttpStatuses || [])
    return cacheLifecycle.withActive([target, temporary], async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })

      let lastError
      for (let attempt = 0; attempt <= config.parser_max_retries; attempt += 1) {
        const currentUrl = downloadUrls[attempt % downloadUrls.length]
        try {
          const metadata = await this.downloadOnce(currentUrl, temporary, {
            headers,
            chunkSize,
            browser,
            retryHttpStatuses: retryStatuses,
          })
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
          if (error instanceof NonRetryableDownloadError) {
            await safeUnlink(temporary)
            throw new DownloadError(`媒体下载失败: ${error.message}`)
          }
          if (error instanceof RetryableDownloadError && !error.keepPartial) {
            await safeUnlink(temporary)
          }
          lastError = error
          if (attempt < config.parser_max_retries) {
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
          }
        }
      }
      await safeUnlink(temporary)
      throw new DownloadError("媒体下载失败: " + errorMessage(lastError))
    })
  }

  async downloadOnce(
    url,
    target,
    { headers = {}, chunkSize = 65536, browser = false, retryHttpStatuses = new Set() } = {},
  ) {
    retryHttpStatuses =
      retryHttpStatuses instanceof Set ? retryHttpStatuses : new Set(retryHttpStatuses || [])
    const existing = fs.existsSync(target) ? (await fs.promises.stat(target)).size : 0
    const requestHeaders = identityHeaders({
      ...headers,
      ...(existing > 0 ? { range: "bytes=" + existing + "-" } : {}),
    })
    if (!browser) {
      let response
      try {
        response = await this.http.request(url, {
          headers: requestHeaders,
          timeout: 240000,
          redirect: "follow",
          allowError: true,
        })
      } catch (error) {
        log.warn(`[parser] node-fetch 下载失败，尝试 got-scraping: ${url}`, errorMessage(error))
      }
      if (response) {
        try {
          validateResponseStatus(response.status, response.headers, existing, retryHttpStatuses)
        } catch (error) {
          response.body?.destroy?.()
          throw error
        }
        const encodings = contentEncodings(response.headers)
        const compressed = encodings.some(value => value !== "identity")
        if (existing > 0 && compressed) {
          throw new RetryableDownloadError(
            `压缩响应 ${encodings.join(", ")} 无法安全断点续传`,
            { keepPartial: false },
          )
        }
        const append = existing > 0
        const baseSize = append ? existing : 0
        const total = compressed ? null : expectedLength(response.headers, baseSize)
        if (!compressed) {
          validateLength(
            { get: name => name === "content-length" ? total : response.headers.get(name) },
            response.url || url,
          )
        }
        try {
          await pipeline(
            response.body,
            sizeLimiter(baseSize),
            fs.createWriteStream(target, {
              flags: append ? "a" : "w",
              highWaterMark: chunkSize,
            }),
          )
        } catch (error) {
          if (error instanceof IgnoreError) throw error
          throw new RetryableDownloadError(errorMessage(error), { keepPartial: !compressed })
        }
        validateDownloadedSize((await fs.promises.stat(target)).size, total)
        return {
          path: target,
          contentType: response.headers.get("content-type"),
          finalUrl: response.url || url,
        }
      }
    }

    const resumed = fs.existsSync(target) ? (await fs.promises.stat(target)).size : 0
    const response = gotScraping.stream({
      url,
      headers: identityHeaders({
        ...COMMON_HEADERS,
        ...headers,
        ...(resumed > 0 ? { range: "bytes=" + resumed + "-" } : {}),
      }),
      timeout: { request: 240000 },
      followRedirect: true,
      throwHttpErrors: false,
    })
    const responseMeta = await new Promise((resolve, reject) => {
      response.once("response", resolve)
      response.once("error", reject)
    })
    try {
      validateResponseStatus(responseMeta.statusCode, responseMeta.headers, resumed, retryHttpStatuses)
    } catch (error) {
      response.destroy()
      throw error
    }
    const compressed = compressedResponse(responseMeta.headers)
    if (resumed > 0 && compressed) {
      response.destroy()
      throw new RetryableDownloadError("压缩响应无法安全断点续传", { keepPartial: false })
    }
    const total = compressed ? null : expectedLength(responseMeta.headers, resumed)
    if (!compressed) {
      validateLength(
        { get: name => name === "content-length" ? total : headerValue(responseMeta.headers, name) },
        responseMeta.url || url,
      )
    }
    try {
      await pipeline(
        response,
        sizeLimiter(resumed),
        fs.createWriteStream(target, {
          flags: resumed > 0 ? "a" : "w",
          highWaterMark: chunkSize,
        }),
      )
    } catch (error) {
      if (error instanceof IgnoreError) throw error
      throw new RetryableDownloadError(errorMessage(error), { keepPartial: !compressed })
    }
    validateDownloadedSize((await fs.promises.stat(target)).size, total)
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
    headers = identityHeaders(headers)
    if (browser) {
      const response = await gotScraping({
        url,
        method: "HEAD",
        headers: identityHeaders({ ...COMMON_HEADERS, ...headers }),
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

  async downloadAVAndMerge(
    videoUrl,
    audioUrl,
    {
      outputPath,
      headers = {},
      h264 = false,
      videoFallbackUrls = [],
      audioFallbackUrls = [],
      retryHttpStatuses = [],
    } = {},
  ) {
    if (fs.existsSync(outputPath)) {
      await cacheLifecycle.touch(outputPath)
      return outputPath
    }
    const [videoPath, audioPath] = await Promise.all([
      this.download(videoUrl, {
        headers,
        suffix: ".mp4",
        detectFormat: "video",
        fallbackUrls: videoFallbackUrls,
        retryHttpStatuses,
      }),
      this.download(audioUrl, {
        headers,
        suffix: ".m4a",
        detectFormat: "audio",
        fallbackUrls: audioFallbackUrls,
        retryHttpStatuses,
      }),
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
