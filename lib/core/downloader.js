import fs from "node:fs"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import { gotScraping } from "got-scraping"

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

function sizeLimiter() {
  let received = 0
  const maximum = config.parser_max_size * 1024 * 1024
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      if (received > maximum) {
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

export class StreamDownloader {
  constructor() {
    this.http = new HttpClient({ headers: COMMON_HEADERS, timeout: 240000, verify: false })
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
    } = {},
  ) {
    const target = path.join(cacheDir, fileName || md5Name(cacheKey || url, suffix))
    if (fs.existsSync(target)) return target
    await fs.promises.mkdir(path.dirname(target), { recursive: true })

    let lastError
    for (let attempt = 0; attempt <= config.parser_max_retries; attempt += 1) {
      try {
        return await this.downloadOnce(url, target, { headers, chunkSize, browser })
      } catch (error) {
        await safeUnlink(target)
        if (error instanceof IgnoreError) throw error
        lastError = error
        if (attempt < config.parser_max_retries) {
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
        }
      }
    }
    throw new DownloadError("媒体下载失败: " + (lastError?.message || "未知错误"))
  }

  async downloadOnce(url, target, { headers, chunkSize, browser }) {
    if (!browser) {
      try {
        const response = await this.http.request(url, {
          headers,
          timeout: 240000,
          redirect: "follow",
        })
        validateLength(response.headers, response.url || url)
        await pipeline(
          response.body,
          sizeLimiter(),
          fs.createWriteStream(target, { highWaterMark: chunkSize }),
        )
        return target
      } catch (error) {
        if (error instanceof IgnoreError) throw error
        log.warn(`[parser] node-fetch 下载失败，尝试 got-scraping: ${url}`, error.message)
      }
    }

    const response = gotScraping.stream({
      url,
      headers: { ...COMMON_HEADERS, ...headers },
      timeout: { request: 240000 },
      followRedirect: true,
    })
    response.once("response", metadata => {
      try {
        validateLength(metadata.headers, metadata.url || url)
      } catch (error) {
        response.destroy(error)
      }
    })
    await pipeline(
      response,
      sizeLimiter(),
      fs.createWriteStream(target, { highWaterMark: chunkSize }),
    )
    return target
  }

  downloadVideo(url, options = {}) {
    return this.download(url, { suffix: ".mp4", chunkSize: 1024 * 1024, ...options })
  }

  downloadAudio(url, options = {}) {
    return this.download(url, { suffix: ".mp3", ...options })
  }

  downloadImage(url, options = {}) {
    return this.download(url, { suffix: ".jpg", ...options })
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
    if (fs.existsSync(outputPath)) return outputPath
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
    if (fs.existsSync(target)) return target
    const output = fs.createWriteStream(target)
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
      return target
    } catch (error) {
      output.destroy()
      await safeUnlink(target)
      throw new DownloadError(`m3u8 视频下载失败: ${error.message}`)
    }
  }
}

export const downloader = new StreamDownloader()
