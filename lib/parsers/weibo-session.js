import { http } from "../core/http.js"
import { COMMON_HEADERS } from "../core/utils.js"

const TTL = 3 * 60 * 60 * 1000

/** Visitor credentials stay in memory and are only sent to the matching Weibo host. */
export class WeiboSession {
  constructor(client = http) {
    this.client = client
    this.cookies = new Map()
    this.expiresAt = 0
    this.pending = null
  }

  remember(response, host) {
    const lines = response.headers?.raw?.()["set-cookie"] || []
    for (const line of lines) {
      const pair = /^([^=;]+)=([^;]*)/.exec(line)
      if (!pair) continue
      const domain = /;\s*domain=\.?([^;]+)/i.exec(line)?.[1]?.toLowerCase() || host
      if (host !== domain && !host.endsWith("." + domain)) continue
      this.cookies.set(domain + ":" + pair[1], { domain, name: pair[1], value: pair[2] })
    }
  }

  cookieHeader(host) {
    return [...this.cookies.values()].filter(item => host === item.domain || host.endsWith("." + item.domain))
      .map(item => item.name + "=" + item.value).join("; ")
  }

  refresh() {
    if (Date.now() < this.expiresAt) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const response = await this.client.request("https://visitor.passport.weibo.cn/visitor/genvisitor2", {
          method: "POST", headers: { ...COMMON_HEADERS, Origin: "https://visitor.passport.weibo.cn",
            Referer: "https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2F" },
          body: new URLSearchParams({ cb: "visitor_gray_callback", tid: "", new_tid: "null" }),
        })
        const match = /visitor_gray_callback\(([\s\S]*)\)\s*;?/.exec(await response.text())
        const data = match ? JSON.parse(match[1]) : null
        if (data?.retcode !== 20000000 || !data.data?.sub) return
        for (const [name, value] of [["SUB", data.data.sub], ["SUBP", data.data.subp]]) {
          if (value) this.cookies.set("weibo.com:" + name, { domain: "weibo.com", name, value })
        }
        const home = await this.client.request("https://www.weibo.com/", {
          headers: { ...COMMON_HEADERS, Referer: "https://visitor.passport.weibo.cn/", cookie: this.cookieHeader("www.weibo.com") },
        })
        this.remember(home, "www.weibo.com")
        home.body?.destroy?.()
        this.expiresAt = Date.now() + TTL
      } catch {
        // Public endpoints may still work when visitor registration is unavailable.
      } finally {
        if (this.expiresAt <= Date.now()) this.expiresAt = Date.now() + 60000
      }
    })().finally(() => { this.pending = null })
    return this.pending
  }

  async request(url, options = {}) {
    const host = new URL(url).hostname.toLowerCase()
    if (!/(^|\.)weibo\.(com|cn)$/.test(host)) throw new Error("无效的微博接口域名")
    await this.refresh()
    const xsrf = [...this.cookies.values()].find(item => item.name === "XSRF-TOKEN" &&
      (host === item.domain || host.endsWith("." + item.domain)))?.value
    const response = await this.client.request(url, { ...options,
      headers: { ...COMMON_HEADERS, referer: "https://www.weibo.com/", ...options.headers,
        ...(xsrf ? { "x-xsrf-token": decodeURIComponent(xsrf) } : {}), cookie: this.cookieHeader(host) },
    })
    this.remember(response, host)
    return response
  }

  async json(url, options) {
    const response = await this.request(url, options)
    return JSON.parse(await response.text())
  }
}

export const weiboSession = new WeiboSession()
