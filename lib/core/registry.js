import { config } from "./config.js"
import { Author, ImageContent, ParseResult, PathTask, VideoContent, AudioContent } from "./model.js"
import { downloader } from "./downloader.js"
import { ffmpeg } from "./ffmpeg.js"

const parserClasses = []
const parserInstances = new Map()
const orderedHandlers = []

export class BaseParser {
  static platform = { name: "unknown", displayName: "未知平台" }
  static handlers = []

  constructor() {
    this.platform = this.constructor.platform
    this.headers = {}
    this.downloader = downloader
  }

  createAuthor(name, avatarUrl = null, description = null, headers = this.headers) {
    return new Author(name, {
      avatar: avatarUrl
        ? new PathTask(
            () => this.downloader.downloadImage(avatarUrl, { headers }),
            `avatar:${name}`,
          )
        : null,
      description,
    })
  }

  createVideo(urlOrTask, coverUrl = null, duration = null, options = {}) {
    const task =
      urlOrTask instanceof PathTask
        ? urlOrTask
        : new PathTask(
            () => this.downloader.downloadVideo(urlOrTask, { headers: options.headers || this.headers }),
            `video:${urlOrTask}`,
          )
    const cover = coverUrl
      ? new PathTask(
          () => this.downloader.downloadImage(coverUrl, { headers: options.headers || this.headers }),
          `cover:${coverUrl}`,
        )
      : new PathTask(async () => ffmpeg.firstFrame(await task.get()), "cover-from-video")
    return new VideoContent(task, {
      cover,
      duration,
      isGif: Boolean(options.isGif),
      gifPath: options.gifPath || null,
    })
  }

  createAudio(urlOrTask, duration = null, options = {}) {
    const task =
      urlOrTask instanceof PathTask
        ? urlOrTask
        : new PathTask(
            () => this.downloader.downloadAudio(urlOrTask, { headers: options.headers || this.headers }),
            `audio:${urlOrTask}`,
          )
    return new AudioContent(task, { duration })
  }

  createGif(url, coverUrl = null, duration = null, headers = this.headers) {
    const videoTask = new PathTask(
      () => this.downloader.downloadVideo(url, { headers }),
      `gif-video:${url}`,
    )
    const gifTask = new PathTask(async () => ffmpeg.toGif(await videoTask.get()), `gif:${url}`)
    return new VideoContent(videoTask, {
      cover: coverUrl
        ? new PathTask(() => this.downloader.downloadImage(coverUrl, { headers }))
        : null,
      duration,
      isGif: true,
      gifPath: gifTask,
    })
  }

  createImage(urlOrTask, alt = null, headers = this.headers) {
    const task =
      urlOrTask instanceof PathTask
        ? urlOrTask
        : new PathTask(
            () => this.downloader.downloadImage(urlOrTask, { headers }),
            `image:${urlOrTask}`,
          )
    return new ImageContent(task, { alt })
  }

  createImages(urls = [], headers = this.headers) {
    return urls.filter(Boolean).map(url => this.createImage(url, null, headers))
  }

  result(values) {
    return new ParseResult({ platform: this.platform, ...values })
  }

  async getRedirectUrl(url, headers = this.headers) {
    const response = await this.downloader.http.request(url, {
      headers,
      redirect: "manual",
      timeout: 20000,
    })
    return response.headers.get("location") || url
  }

  async parseWithRedirect(url) {
    const redirected = await this.getRedirectUrl(url)
    if (redirected === url) throw new Error(`无法重定向 URL: ${url}`)
    const match = matchUrl(redirected, this.constructor)
    if (!match) throw new Error(`重定向链接无法识别: ${redirected}`)
    return this[match.method](match.match, match)
  }
}

export function registerParser(ParserClass) {
  if (parserClasses.includes(ParserClass)) return
  parserClasses.push(ParserClass)
  if (config.parser_disabled_platforms.includes(ParserClass.platform.name)) return
  const parser = new ParserClass()
  parserInstances.set(ParserClass, parser)
  for (const handler of ParserClass.handlers) {
    orderedHandlers.push({
      parser,
      ParserClass,
      keyword: handler.keyword,
      pattern: handler.pattern instanceof RegExp ? handler.pattern : new RegExp(handler.pattern, "i"),
      method: handler.method,
    })
  }
  orderedHandlers.sort((left, right) => right.keyword.length - left.keyword.length)
}

export function getParser(ParserClass) {
  return parserInstances.get(ParserClass)
}

export function enabledPlatforms() {
  return [...new Set(orderedHandlers.map(item => item.parser.platform.displayName))].sort()
}

export function matchUrl(text, restrictClass = null) {
  for (const handler of orderedHandlers) {
    if (restrictClass && handler.ParserClass !== restrictClass) continue
    if (!String(text).includes(String(handler.keyword))) continue
    handler.pattern.lastIndex = 0
    const match = handler.pattern.exec(text)
    if (match) return { ...handler, match }
  }
  return null
}

export function clearRegistryForTests() {
  parserClasses.length = 0
  parserInstances.clear()
  orderedHandlers.length = 0
}
