import https from "node:https"
import fetch from "node-fetch"
import { gotScraping } from "got-scraping"

import { COMMON_HEADERS } from "./utils.js"

const insecureAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

function encodeBody(body, headers) {
  if (
    body === undefined ||
    body === null ||
    Buffer.isBuffer(body) ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    typeof body === "string"
  ) {
    return body
  }
  if (body instanceof URLSearchParams) {
    headers["content-type"] ||= "application/x-www-form-urlencoded"
    return body.toString()
  }
  headers["content-type"] ||= "application/json"
  return JSON.stringify(body)
}

function requestUrl(url, params) {
  if (!params || Object.keys(params).length === 0) return String(url)
  const parsed = new URL(String(url))
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) parsed.searchParams.set(key, String(value))
  }
  return parsed.href
}

function cookieHeader(cookies) {
  if (!cookies || typeof cookies !== "object") return null
  return Object.entries(cookies)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => key + "=" + value)
    .join("; ")
}

export class HttpClient {
  constructor({ headers = COMMON_HEADERS, timeout = 20000, verify = false } = {}) {
    this.headers = { ...headers }
    this.timeout = timeout
    this.verify = verify
  }

  async request(url, options = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeout || this.timeout)
    timeout.unref?.()
    let streaming = false
    const headers = { ...this.headers, ...(options.headers || {}) }
    const cookies = cookieHeader(options.cookies)
    if (cookies) headers.cookie = headers.cookie ? headers.cookie + "; " + cookies : cookies
    const body = encodeBody(options.body, headers)
    const verify = options.verify ?? this.verify
    try {
      const response = await fetch(requestUrl(url, options.params), {
        method: options.method || "GET",
        headers,
        body,
        redirect: options.redirect || "follow",
        signal: controller.signal,
        agent: verify
          ? undefined
          : parsedUrl => (parsedUrl.protocol === "https:" ? insecureAgent : undefined),
      })
      if (!options.allowError && !response.ok && !(response.status >= 300 && response.status < 400)) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}: ${url}`)
        error.response = response
        response.body?.destroy?.()
        throw error
      }
      if (response.body && String(options.method || "GET").toUpperCase() !== "HEAD") {
        streaming = true
        const done = () => clearTimeout(timeout)
        response.body.once("end", done)
        response.body.once("close", done)
        response.body.once("error", done)
      }
      return response
    } finally {
      if (!streaming) clearTimeout(timeout)
    }
  }

  async browserRequest(url, options = {}) {
    const headers = { ...this.headers, ...(options.headers || {}) }
    const cookies = cookieHeader(options.cookies)
    if (cookies) headers.cookie = headers.cookie ? headers.cookie + "; " + cookies : cookies
    const body = encodeBody(options.body, headers)
    return gotScraping({
      url: requestUrl(url, options.params),
      method: options.method || "GET",
      headers,
      body,
      responseType: options.responseType || "buffer",
      timeout: { request: options.timeout || this.timeout },
      followRedirect: options.redirect !== "manual",
      throwHttpErrors: !options.allowError,
    })
  }

  async text(url, options = {}) {
    if (options.browser) {
      const response = await this.browserRequest(url, { ...options, responseType: "text" })
      return response.body
    }
    const response = await this.request(url, options)
    return response.text()
  }

  async json(url, options = {}) {
    if (options.browser) {
      const response = await this.browserRequest(url, { ...options, responseType: "text" })
      return JSON.parse(response.body)
    }
    const response = await this.request(url, options)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      error.message = `JSON 解析失败(${url}): ${error.message}`
      throw error
    }
  }

  async buffer(url, options = {}) {
    if (options.browser) {
      const response = await this.browserRequest(url, { ...options, responseType: "buffer" })
      return response.body
    }
    const response = await this.request(url, options)
    return Buffer.from(await response.arrayBuffer())
  }
}

export const http = new HttpClient({ verify: true })
