import fs from "node:fs"
import path from "node:path"

import { config } from "../core/config.js"
import { TipError } from "../core/errors.js"
import { http } from "../core/http.js"
import { log } from "../core/logger.js"
import { dataDir } from "../core/paths.js"
import { COMMON_HEADERS } from "../core/utils.js"

const SESSION_URL = "https://linux.do/session/current.json"
const IDENTITY_COOKIE = "_t"
const CLEARED = new Set(["", "deleted", "null", "none", "undefined", "-"])

function cleared(value) {
  return value === null || value === undefined || CLEARED.has(String(value).trim().replace(/^"|"$/g, "").toLowerCase())
}

export function parseCookieString(raw) {
  const output = {}
  for (const part of String(raw || "").split(";")) {
    const index = part.indexOf("=")
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name && !cleared(value)) output[name] = value
  }
  return output
}

function serializeCookies(cookies) {
  return Object.keys(cookies).sort().map(name => `${name}=${cookies[name]}`).join("; ")
}

function responseStatus(response) {
  return Number(response?.statusCode ?? response?.status ?? 0)
}

function responseUrl(response) {
  return String(response?.url || response?.requestUrl || "https://linux.do/")
}

function setCookieHeaders(response) {
  const headers = response?.headers || {}
  if (typeof headers.raw === "function") return headers.raw()["set-cookie"] || []
  const value = headers["set-cookie"] || headers.get?.("set-cookie")
  return Array.isArray(value) ? value : value ? [value] : []
}

export function responseCookies(response) {
  const values = {}
  for (const header of setCookieHeaders(response)) {
    const first = String(header).split(";", 1)[0]
    const index = first.indexOf("=")
    if (index <= 0) continue
    values[first.slice(0, index).trim()] = first.slice(index + 1).trim()
  }
  return values
}

export function formatResponseDiagnostics(response) {
  const headers = response?.headers || {}
  const get = name => headers.get?.(name) ?? headers[name]
  const names = typeof headers.keys === "function" ? [...headers.keys()] : Object.keys(headers)
  const cloudflare = names.filter(name => String(name).toLowerCase().startsWith("cf-")).sort()
  return `status=${responseStatus(response)} url=${responseUrl(response)} ` +
    `content_type=${String(get("content-type") || "")} server=${String(get("server") || "")} ` +
    `content_length=${String(get("content-length") || "")} cf_headers=${cloudflare.join(",")}`
}

export class LinuxDoAuth {
  constructor({ cookiePath = path.join(dataDir, "linuxdo_cookies.txt"), client = http } = {}) {
    this.cookiePath = path.resolve(cookiePath)
    this.client = client
    this.headers = {
      ...COMMON_HEADERS,
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: "https://linux.do/",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-requested-with": "XMLHttpRequest",
      "discourse-logged-in": "true",
    }
    this.cached = null
    this.bootstrapRaw = null
    this.validation = null
    this.validationExpiresAt = 0
    this.validationPromise = null
    this.failedProbeAt = 0
    this.writePromise = Promise.resolve()
  }

  async readDisk() {
    try {
      return parseCookieString(await fs.promises.readFile(this.cookiePath, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") log.warn(`[parser] Linux Do Cookie 缓存读取失败: ${error?.code || error?.name}`)
      return {}
    }
  }

  async cookies() {
    const raw = String(config.parser_linuxdo_ck || "")
    if (this.cached !== null && raw === this.bootstrapRaw) return { ...this.cached }
    const disk = await this.readDisk()
    const bootstrap = parseCookieString(raw)
    if (!Object.keys(bootstrap).length) this.cached = { ...disk }
    else if (bootstrap[IDENTITY_COOKIE] && bootstrap[IDENTITY_COOKIE] !== disk[IDENTITY_COOKIE]) {
      this.cached = { ...bootstrap }
    } else {
      this.cached = { ...bootstrap, ...disk }
    }
    this.bootstrapRaw = raw
    return { ...this.cached }
  }

  async persist() {
    const values = Object.fromEntries(Object.entries(this.cached || {}).filter(([, value]) => !cleared(value)))
    if (!Object.keys(values).length) return
    const body = serializeCookies(values)
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(this.cookiePath), { recursive: true })
      try {
        if (await fs.promises.readFile(this.cookiePath, "utf8") === body) return
      } catch {}
      const temporary = `${this.cookiePath}.${process.pid}.${Date.now()}.tmp`
      try {
        await fs.promises.writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" })
        await fs.promises.rename(temporary, this.cookiePath)
      } finally {
        await fs.promises.unlink(temporary).catch(() => {})
      }
    })
    return this.writePromise.catch(error => {
      log.warn(`[parser] Linux Do Cookie 缓存保存失败: ${error?.code || error?.name}`)
    })
  }

  async updateFromResponse(response) {
    await this.cookies()
    let changed = false
    for (const [name, value] of Object.entries(responseCookies(response))) {
      if (cleared(value)) {
        if (Object.prototype.hasOwnProperty.call(this.cached, name)) {
          delete this.cached[name]
          changed = true
          if (name === IDENTITY_COOKIE) {
            this.validation = null
            this.validationExpiresAt = 0
          }
        }
      } else if (this.cached[name] !== value) {
        this.cached[name] = value
        changed = true
      }
    }
    if (changed || (responseStatus(response) >= 200 && responseStatus(response) < 300)) await this.persist()
  }

  async request(url) {
    const cookies = await this.cookies()
    const response = await this.client.browserRequest(url, {
      headers: this.headers,
      cookies,
      responseType: "text",
      allowError: true,
    })
    await this.updateFromResponse(response)
    return response
  }

  setValidation(value, ttlMs) {
    this.validation = value
    this.validationExpiresAt = Date.now() + ttlMs
    return value
  }

  async validateLogin({ force = false } = {}) {
    if (!force && Date.now() < this.validationExpiresAt) return this.validation
    if (this.validationPromise) return this.validationPromise
    this.validationPromise = (async () => {
      const cookies = await this.cookies()
      if (!cookies[IDENTITY_COOKIE]) return this.setValidation(false, 60000)
      try {
        const response = await this.request(SESSION_URL)
        const status = responseStatus(response)
        if (status === 404) return this.setValidation(false, 60000)
        if (status !== 200) return this.setValidation(null, 30000)
        const data = JSON.parse(String(response.body || "{}"))
        return this.setValidation(Boolean(data?.current_user), data?.current_user ? 600000 : 60000)
      } catch (error) {
        log.warn(`[parser] Linux Do 登录态校验失败: ${error?.code || error?.name}`)
        return this.setValidation(null, 30000)
      }
    })().finally(() => { this.validationPromise = null })
    return this.validationPromise
  }

  async tipForStatus(status) {
    if (status === 429) return new TipError("Linux Do 请求过于频繁，请稍后再试")
    if ([401, 403, 404].includes(status)) {
      const cookies = await this.cookies()
      if (Date.now() - this.failedProbeAt >= 60000) {
        this.failedProbeAt = Date.now()
        if (this.validation === true) this.validationExpiresAt = 0
      }
      const state = await this.validateLogin()
      if (state === false) {
        return new TipError(Object.keys(cookies).length
          ? "Linux Do 登录态已失效，请更新 Cookie"
          : "该 Linux Do 帖子需要登录或更高等级权限，请配置 Cookie")
      }
      if (state === true) {
        return new TipError(status === 404
          ? "Linux Do 帖子不存在，或当前账号权限/等级不足"
          : "Linux Do 拒绝了请求，可能是权限或风控限制")
      }
      return new TipError("Linux Do 暂时无法确认登录态，可能是权限不足或站点风控")
    }
    if (status >= 500) return new TipError("Linux Do 服务暂时不可用，请稍后再试")
    return new TipError(`Linux Do 请求失败（HTTP ${status}）`)
  }
}
