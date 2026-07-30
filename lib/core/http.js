import https from "node:https"
import fetch from "node-fetch"

import { COMMON_HEADERS } from "./utils.js"

const insecureAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

function encodeBody(body, headers) {
  if (body === undefined || body === null || Buffer.isBuffer(body) || typeof body === "string") {
    return body
  }
  if (body instanceof URLSearchParams) {
    headers["content-type"] ||= "application/x-www-form-urlencoded"
    return body.toString()
  }
  headers["content-type"] ||= "application/json"
  return JSON.stringify(body)
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
    const headers = { ...this.headers, ...(options.headers || {}) }
    const body = encodeBody(options.body, headers)
    const verify = options.verify ?? this.verify
    try {
      const response = await fetch(url, {
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
        throw error
      }
      return response
    } finally {
      clearTimeout(timeout)
    }
  }

  async text(url, options = {}) {
    const response = await this.request(url, options)
    return response.text()
  }

  async json(url, options = {}) {
    const response = await this.request(url, options)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      error.message = `JSON 解析失败(${url}): ${error.message}`
      throw error
    }
  }
}

export const http = new HttpClient({ verify: true })
