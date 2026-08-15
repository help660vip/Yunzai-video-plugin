import { config, normalizePlatformName } from "./config.js"
import { Creator } from "./creator.js"
import { ParseResult } from "./model.js"
import { downloader } from "./downloader.js"

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

  createAuthor(name, avatarUrl = null, description = null, headers = this.headers, options = {}) {
    return Creator.author(name, { avatarUrl, description, headers, ...options })
  }

  createVideo(urlOrTask, coverUrl = null, duration = null, options = {}) {
    return Creator.video(urlOrTask, {
      coverUrl,
      duration,
      headers: options.headers || this.headers,
      ...options,
    })
  }

  createAudio(urlOrTask, duration = null, options = {}) {
    return Creator.audio(urlOrTask, {
      duration,
      headers: options.headers || this.headers,
      ...options,
    })
  }

  createGif(url, coverUrl = null, duration = null, headers = this.headers) {
    return Creator.gif(url, {
      coverUrl,
      duration,
      headers,
    })
  }

  createImage(urlOrTask, alt = null, headers = this.headers) {
    return Creator.image(urlOrTask, { alt, headers })
  }

  createImages(urls = [], headers = this.headers) {
    return Creator.images(urls, { headers })
  }

  createGraphic(urlOrTask, alt = null, options = {}) {
    return Creator.graphic(urlOrTask, {
      alt,
      headers: options.headers || this.headers,
      ...options,
    })
  }

  createSticker(url, size = "medium", description = null, options = {}) {
    return Creator.sticker(url, {
      size,
      description,
      headers: options.headers || this.headers,
      ...options,
    })
  }

  createLivePhoto(videoUrl, imageUrl, bgmUrl = null, loop = 1, options = {}) {
    return Creator.livePhoto(videoUrl, imageUrl, {
      bgmUrl,
      loop,
      headers: options.headers || this.headers,
      ...options,
    })
  }

  createStats(values = {}) {
    return Creator.stats(values)
  }

  createComment(values) {
    return Creator.comment(values)
  }

  createLink(url, options = {}) {
    return Creator.link(url, { headers: options.headers || this.headers, ...options })
  }

  createQuote(text, options = {}) {
    return Creator.quote(text, { headers: options.headers || this.headers, ...options })
  }

  createPoll(values = {}) {
    return Creator.poll(values)
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
  const parser = new ParserClass()
  parserInstances.set(ParserClass, parser)
  for (const handler of ParserClass.handlers) {
    const pattern = handler.pattern
      ? handler.pattern instanceof RegExp
        ? handler.pattern
        : new RegExp(handler.pattern, "i")
      : new RegExp(
          "https?://(?:[A-Za-z0-9-]+\\.)*" +
            escapeRegex(handler.keyword) +
            "[^\\s]*",
          "i",
        )
    orderedHandlers.push({
      parser,
      ParserClass,
      keyword: handler.keyword,
      pattern,
      params: handler.params || {},
      method: handler.method,
    })
  }
  orderedHandlers.sort((left, right) => right.keyword.length - left.keyword.length)
}

export function getParser(ParserClass) {
  if (!isParserEnabled(ParserClass)) return undefined
  return parserInstances.get(ParserClass)
}

export function enabledPlatforms() {
  return [
    ...new Set(
      orderedHandlers
        .filter(item => isParserEnabled(item.ParserClass))
        .map(item => item.parser.platform.displayName),
    ),
  ].sort()
}

export function matchUrl(text, restrictClass = null) {
  for (const handler of orderedHandlers) {
    if (restrictClass && handler.ParserClass !== restrictClass) continue
    if (!isParserEnabled(handler.ParserClass)) continue
    if (!String(text).includes(String(handler.keyword))) continue
    handler.pattern.lastIndex = 0
    const match = handler.pattern.exec(text)
    if (!match) continue
    const params = matchParams(match[0], handler.params)
    if (params === null) continue
    return {
      ...handler,
      match,
      params,
      cacheKey: cacheKeyFor(match[0], handler.params, params),
    }
  }
  return null
}

export function isParserEnabled(ParserClass) {
  const name = normalizePlatformName(ParserClass?.platform?.name)
  return !config.parser_disabled_platforms.includes(name)
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchParams(rawUrl, rules) {
  if (!rules || Object.keys(rules).length === 0) return {}
  let url
  try {
    const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl
    url = new URL(candidate)
  } catch {
    return null
  }
  const params = Object.fromEntries(url.searchParams.entries())
  if (url.hash.includes("?")) {
    const hashParams = new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1))
    for (const [key, value] of hashParams) params[key] = value
  }
  for (const [name, rule] of Object.entries(rules)) {
    let value = params[name]
    if ((value === undefined || value === "") && rule.default !== undefined) {
      value = String(rule.default)
      params[name] = value
    }
    if (value === undefined || value === "") {
      if (rule.required !== false) return null
      continue
    }
    if (rule.equals !== undefined && value !== String(rule.equals)) return null
    const oneOf = rule.oneOf || rule.one_of
    if (Array.isArray(oneOf) && !oneOf.map(String).includes(value)) return null
    if ((rule.asInt || rule.as_int) && !/^-?\d+$/.test(value)) return null
  }
  return params
}

function cacheKeyFor(url, rules, params) {
  const keys = Object.keys(rules || {}).sort()
  if (!keys.length) return url
  const used = keys.filter(key => params[key] !== undefined)
  if (!used.length) return url
  const base = url.split(/[?#]/, 1)[0]
  return (
    base +
    "?" +
    used
      .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(params[key]))
      .join("&")
  )
}

export function clearRegistryForTests() {
  parserClasses.length = 0
  parserInstances.clear()
  orderedHandlers.length = 0
}
