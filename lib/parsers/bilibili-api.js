import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { HttpClient } from "../core/http.js"
import { dataDir } from "../core/paths.js"
import { cookieHeader, parseCookieString } from "../core/utils.js"
import { log } from "../core/logger.js"
import { biliGrpc, BILI_APP, signBiliApp } from "./bilibili-rpc.js"

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
  0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44,
  52,
]

const REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`

const API_ROOT = "https://api.bilibili.com"
const PASSPORT_ROOT = "https://passport.bilibili.com"
const credentialPath = path.join(dataDir, "bilibili_cookies.json")
const appCredentialPath = path.join(dataDir, "bilibili_access.json")

function normalizeCookieName(name) {
  const mapping = {
    dedeuserid: "DedeUserID",
    dedeuserid__ckmd5: "DedeUserID__ckMd5",
    sessdata: "SESSDATA",
    bili_jct: "bili_jct",
    buvid3: "buvid3",
    buvid4: "buvid4",
    ac_time_value: "ac_time_value",
  }
  return mapping[String(name).toLowerCase()] || name
}

function parseSetCookies(response) {
  const values = response.headers.raw?.()["set-cookie"] || []
  const result = {}
  for (const raw of values) {
    const first = raw.split(";", 1)[0]
    const index = first.indexOf("=")
    if (index > 0) result[normalizeCookieName(first.slice(0, index))] = first.slice(index + 1)
  }
  return result
}

function encodeQuery(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined) query.set(key, String(value))
  }
  return query
}

function checkApi(wrapper, label = "B站 API") {
  if (!wrapper || wrapper.code !== 0) {
    throw new ParseError(`${label} 请求失败: ${wrapper?.message || wrapper?.code || "未知错误"}`)
  }
  return wrapper.data
}

export class BilibiliApi {
  constructor() {
    this.http = new HttpClient({
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        referer: "https://www.bilibili.com/",
      },
      timeout: 20000,
      verify: true,
    })
    this.cookies = null
    this.initPromise = null
    this.configuredCookie = undefined
    this.wbi = null
    this.appCredential = undefined
    this.appRefreshPromise = null
  }

  get headers() {
    return {
      referer: "https://www.bilibili.com/",
      ...(this.cookies ? { cookie: cookieHeader(this.cookies) } : {}),
    }
  }

  saveCookies() {
    if (!this.cookies) return
    fs.writeFileSync(credentialPath, JSON.stringify(this.cookies), "utf8")
  }

  loadSavedCookies() {
    if (!fs.existsSync(credentialPath)) return null
    try {
      return JSON.parse(fs.readFileSync(credentialPath, "utf8"))
    } catch {
      return null
    }
  }

  async checkValid(cookies) {
    if (!cookies?.SESSDATA) return false
    try {
      const data = await this.json(`${API_ROOT}/x/web-interface/nav`, {
        cookies,
        check: false,
      })
      return data.code === 0 && Boolean(data.data?.isLogin)
    } catch {
      return false
    }
  }

  async initCredential() {
    const configured = config.parser_bili_ck
      ? Object.fromEntries(
          Object.entries(parseCookieString(config.parser_bili_ck)).map(([key, value]) => [
            normalizeCookieName(key),
            value,
          ]),
        )
      : null
    if (configured && (await this.checkValid(configured))) {
      this.cookies = configured
      this.saveCookies()
      log.info("[parser] `parser_bili_ck` 有效，已保存凭据")
    } else {
      if (configured) log.info("[parser] `parser_bili_ck` 已过期，尝试读取扫码凭据")
      const saved = this.loadSavedCookies()
      this.cookies = (await this.checkValid(saved)) ? saved : null
    }
    return this.cookies
  }

  async credential() {
    if (this.configuredCookie !== config.parser_bili_ck) {
      this.configuredCookie = config.parser_bili_ck
      this.cookies = null
      this.initPromise = null
      this.wbi = null
    }
    if (!this.initPromise) this.initPromise = this.initCredential()
    await this.initPromise
    if (!this.cookies) return null
    if (!(await this.checkValid(this.cookies))) {
      log.warn("[parser] 哔哩哔哩凭证已过期，请重新配置或扫码")
      this.cookies = null
      return null
    }
    await this.refreshIfNeeded()
    return this.cookies
  }

  async json(url, { method = "GET", params = null, body = null, headers = {}, cookies, check = true } = {}) {
    const target = new URL(url)
    if (params) {
      for (const [key, value] of encodeQuery(params)) target.searchParams.set(key, value)
    }
    const activeCookies = cookies === undefined ? this.cookies : cookies
    const response = await this.http.request(target, {
      method,
      headers: {
        ...headers,
        ...(activeCookies ? { cookie: cookieHeader(activeCookies) } : {}),
      },
      body,
    })
    const wrapper = JSON.parse(await response.text())
    return check ? checkApi(wrapper) : wrapper
  }

  async wbiKeys() {
    if (this.wbi && Date.now() - this.wbi.time < 6 * 60 * 60 * 1000) return this.wbi.key
    const nav = await this.json(`${API_ROOT}/x/web-interface/nav`, { check: false })
    const imgUrl = nav.data?.wbi_img?.img_url || ""
    const subUrl = nav.data?.wbi_img?.sub_url || ""
    const key = `${path.basename(imgUrl).split(".")[0]}${path.basename(subUrl).split(".")[0]}`
    const mixed = MIXIN_KEY_ENC_TAB.map(index => key[index])
      .join("")
      .slice(0, 32)
    this.wbi = { key: mixed, time: Date.now() }
    return mixed
  }

  async signWbi(params) {
    const values = { ...params, wts: Math.floor(Date.now() / 1000) }
    const query = Object.keys(values)
      .sort()
      .map(key => {
        const value = String(values[key]).replace(/[!'()*]/g, "")
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      })
      .join("&")
    const wRid = crypto
      .createHash("md5")
      .update(query + (await this.wbiKeys()))
      .digest("hex")
    return { ...values, w_rid: wRid }
  }

  async refreshIfNeeded() {
    if (!this.cookies) return
    try {
      const info = await this.json(`${PASSPORT_ROOT}/x/passport-login/web/cookie/info`, {
        params: { csrf: this.cookies.bili_jct },
      })
      if (!info.refresh) return
      if (!this.cookies.ac_time_value || !this.cookies.bili_jct) {
        log.warn("[parser] 哔哩哔哩凭证刷新需要 SESSDATA、bili_jct、ac_time_value")
        return
      }
      const encrypted = crypto.publicEncrypt(
        {
          key: REFRESH_PUBLIC_KEY,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(`refresh_${info.timestamp}`),
      )
      const correspond = encrypted.toString("hex")
      const page = await this.http.text(`https://www.bilibili.com/correspond/1/${correspond}`, {
        headers: this.headers,
      })
      const refreshCsrf = /<div[^>]+id=["']1-name["'][^>]*>([^<]+)<\/div>/.exec(page)?.[1]
      if (!refreshCsrf) throw new Error("未获取 refresh_csrf")
      const oldRefreshToken = this.cookies.ac_time_value
      const form = new URLSearchParams({
        csrf: this.cookies.bili_jct,
        refresh_csrf: refreshCsrf,
        source: "main_web",
        refresh_token: oldRefreshToken,
      })
      const response = await this.http.request(
        `${PASSPORT_ROOT}/x/passport-login/web/cookie/refresh`,
        {
          method: "POST",
          headers: {
            ...this.headers,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        },
      )
      const wrapper = JSON.parse(await response.text())
      const data = checkApi(wrapper, "B站凭据刷新")
      const freshCookies = { ...this.cookies, ...parseSetCookies(response) }
      freshCookies.ac_time_value = data.refresh_token
      this.cookies = freshCookies
      await this.json(`${PASSPORT_ROOT}/x/passport-login/web/confirm/refresh`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf: freshCookies.bili_jct,
          refresh_token: oldRefreshToken,
        }),
      })
      this.saveCookies()
      log.info("[parser] 哔哩哔哩凭据刷新成功")
    } catch (error) {
      log.warn(`[parser] 哔哩哔哩凭据刷新失败: ${error.message}`)
    }
  }

  async startQrLogin() {
    try {
      const data = await this.json(PASSPORT_ROOT + "/x/passport-tv-login/qrcode/auth_code", {
        method: "POST", cookies: null,
        params: signBiliApp({ local_id: "0" }, { common: false }),
      })
      if (!data?.url || !data?.auth_code) throw new ParseError("二维码响应不完整")
      return { url: data.url, key: "app:" + data.auth_code }
    } catch {
      return this.startWebQrLogin()
    }
  }

  async startWebQrLogin() {
    const response = await this.json(
      `${PASSPORT_ROOT}/x/passport-login/web/qrcode/generate`,
      { cookies: null },
    )
    return { url: response.url, key: response.qrcode_key }
  }

  async pollQrLogin(key) {
    if (String(key).startsWith("app:")) {
      const wrapper = await this.json(PASSPORT_ROOT + "/x/passport-tv-login/qrcode/poll", {
        method: "POST", cookies: null, check: false,
        params: signBiliApp({ auth_code: key.slice(4), local_id: "0" }, { common: false }),
      })
      if (wrapper.code === 0) this.acceptAppCredential(wrapper.data)
      if (![0, 86038, 86039, 86090].includes(wrapper.code)) throw new ParseError("B站扫码验证失败")
      return { code: wrapper.code }
    }
    return this.pollWebQrLogin(key)
  }

  async pollWebQrLogin(key) {
    const target = new URL(`${PASSPORT_ROOT}/x/passport-login/web/qrcode/poll`)
    target.searchParams.set("qrcode_key", key)
    const response = await this.http.request(target, { headers: this.headers })
    const wrapper = JSON.parse(await response.text())
    const data = checkApi(wrapper, "B站扫码登录")
    if (data.code === 0) {
      this.cookies = {
        ...parseSetCookies(response),
        ac_time_value: data.refresh_token,
      }
      this.configuredCookie = config.parser_bili_ck
      this.saveCookies()
      this.initPromise = Promise.resolve(this.cookies)
    }
    return data
  }

  acceptAppCredential(data) {
    const token = data?.token_info
    if (!token?.access_token) throw new ParseError("B站登录凭据不完整")
    this.appCredential = {
      accessKey: token.access_token, refreshToken: token.refresh_token || "",
      mid: String(token.mid || ""), expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
    }
    const cookies = Object.fromEntries((data.cookie_info?.cookies || []).map(item => [normalizeCookieName(item.name), item.value]))
    if (cookies.SESSDATA) {
      this.cookies = cookies
      this.configuredCookie = config.parser_bili_ck
      this.initPromise = Promise.resolve(cookies)
      this.saveCookies()
    }
    const temp = appCredentialPath + ".tmp"
    fs.writeFileSync(temp, JSON.stringify(this.appCredential), { encoding: "utf8", mode: 0o600 })
    fs.renameSync(temp, appCredentialPath)
  }

  async accessCredential() {
    if (config.parser_bili_access_key) {
      return { accessKey: config.parser_bili_access_key, mid: this.cookies?.DedeUserID || null }
    }
    if (this.appCredential === undefined) {
      try { this.appCredential = JSON.parse(fs.readFileSync(appCredentialPath, "utf8")) }
      catch { this.appCredential = null }
    }
    const stored = this.appCredential
    if (stored?.accessKey && stored.refreshToken && stored.expiresAt && stored.expiresAt <= Date.now()) {
      if (!this.appRefreshPromise) this.appRefreshPromise = (async () => {
        const data = await this.json(PASSPORT_ROOT + "/api/v2/oauth2/refresh_token", {
          method: "POST", cookies: null,
          params: signBiliApp({ access_key: stored.accessKey, refresh_token: stored.refreshToken }, { common: false }),
        })
        this.acceptAppCredential(data)
      })().finally(() => { this.appRefreshPromise = null })
      try { await this.appRefreshPromise } catch { throw new ParseError("B站登录已过期，请重新扫码登录") }
    }
    return this.appCredential || { accessKey: "", mid: null }
  }

  async grpc(method, requestType, replyType, data) {
    return biliGrpc(method, requestType, replyType, data, await this.accessCredential())
  }

  async appJson(url, params = {}) {
    const credential = await this.accessCredential()
    return this.json(url, {
      params: signBiliApp({ ...params, ...(credential.accessKey ? { access_key: credential.accessKey } : {}) }),
      headers: { "app-key": BILI_APP.mobi_app, env: "prod", "user-agent": "BiliDroid/1.45.0" },
    })
  }

  videoDetail({ bvid, avid }) {
    return this.grpc("/bilibili.app.view.v1.View/View", "VideoRequest", "VideoResponse", { bvid, aid: avid })
  }

  playback({ aid, cid, quality = 80, codecs = ["avc"] }) {
    return this.grpc("/bilibili.app.playurl.v1.PlayURL/PlayView", "PlaybackRequest", "PlaybackResponse", {
      aid, cid, quality, flags: 4048, allow4k: quality >= 120, hostMode: 2,
      source: "main.ugc-video-detail.0.0", previous: "main.my-history.0.0",
      codec: { avc: 1, hev: 2, av01: 3 }[codecs[0]] || 0,
    })
  }

  postDetail(id) {
    return this.grpc("/bilibili.app.dynamic.v2.Dynamic/DynDetail", "PostRequest", "PostResponse", {
      id: String(id), shareId: "dt.opus-detail.0.0.pv", shareMode: 3, timezone: 8,
      player: { quality: 32, flags: 400 },
    })
  }

  articleDetail(id, kind = 0) {
    return this.grpc("/bilibili.app.dynamic.v2.Opus/OpusDetail", "ArticleRequest", "ArticleResponse", {
      id: String(id), kind, shareId: "dt.opus-detail.0.0.pv", shareMode: 3, timezone: 8,
      player: { quality: 32, flags: 400 },
    })
  }

  comments(id, kind = 1) {
    return this.grpc("/bilibili.main.community.reply.v1.Reply/MainList", "CommentsRequest", "CommentsResponse", {
      id: String(id), kind, cursor: { next: 0, mode: 3 },
      ...(kind === 17 ? { extra: '{"spmid":"dt.dt-detail.0.0","from_spmid":""}', filter: "全部" } : {}),
    })
  }

  userInfo(mid) {
    return this.appJson("https://app.bilibili.com/x/v2/space", { vmid: String(mid) })
  }

  userVideos(mid, { aid = "0", pageSize = 20, keyword = "", order = "pubdate" } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new RangeError("无效的分页大小")
    return this.appJson("https://app.bilibili.com/x/v2/space/archive/cursor", { vmid: String(mid), aid, ps: pageSize, keyword, order })
  }

  userDynamics(mid, { cursor = "", page = 1 } = {}) {
    if (!Number.isInteger(page) || page < 1) throw new RangeError("无效的页码")
    return this.grpc("/bilibili.app.dynamic.v2.Dynamic/DynSpace", "UserPostsRequest", "UserPostsResponse", { id: String(mid), cursor, page, timezone: 8 })
  }

  search(keyword, { type = 0, page = 1, pageSize = 20, order = "totalrank", duration = 0, categoryId = 0, userType = 0 } = {}) {
    if (!String(keyword).trim() || ![0, 2, 7, 8].includes(type) || !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new RangeError("无效的搜索参数")
    const params = { keyword, pn: page, ps: pageSize }
    if (type === 0) Object.assign(params, { order, duration, rid: categoryId })
    else Object.assign(params, { type, ...(type === 2 ? { disable_rcmd: 0, highlight: 1, order, user_type: userType } : {}) })
    return this.appJson("https://app.bilibili.com/x/v2/search" + (type ? "/type" : ""), params)
  }

  bangumi({ epId, seasonId }) {
    if (!epId && !seasonId) throw new TypeError("缺少番剧编号")
    return this.appJson(API_ROOT + "/pgc/view/v2/app/season", { ep_id: epId, season_id: seasonId })
  }
}

export const biliApi = new BilibiliApi()

export function biliUrl(value) {
  if (!value) return null
  return value.startsWith("//") ? `https:${value}` : value
}
