import crypto from "node:crypto"
import { load } from "cheerio"

import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"

function showText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\n\n/g, "").trim()
}

function statusText(value) {
  return String(value || "").replace(/<br \/>/g, "\n").replace(/<[^>]*>/g, "")
}

function base62Encode(number) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  if (number === 0) return "0"
  let value = number
  let result = ""
  while (value > 0) {
    result = alphabet[value % 62] + result
    value = Math.floor(value / 62)
  }
  return result
}

export function midToId(mid) {
  const reversed = String(mid).split("").reverse().join("")
  const size = Math.ceil(reversed.length / 7)
  const parts = []
  for (let index = 0; index < size; index += 1) {
    const part = reversed
      .slice(index * 7, (index + 1) * 7)
      .split("")
      .reverse()
      .join("")
    let encoded = base62Encode(Number(part))
    if (index < size - 1) encoded = encoded.padStart(4, "0")
    parts.push(encoded)
  }
  return parts.reverse().join("")
}

export class WeiboParser extends BaseParser {
  static platform = { name: "weibo", displayName: "微博" }
  static handlers = [
    {
      keyword: "weibo.com/tv",
      pattern: /weibo\.com\/tv\/show\/\d{4}:\d+\?mid=(?<mid>\d+)/,
      method: "parseTv",
    },
    {
      keyword: "video.weibo",
      pattern: /video\.weibo\.com\/show\?fid=(?<fid>\d+:\d+)/,
      method: "parseFidMatch",
    },
    {
      keyword: "m.weibo.cn",
      pattern: /weibo\.cn\/(?:status|detail|\d+)\/(?<wid>[0-9a-zA-Z]+)/,
      method: "parseStatusMatch",
    },
    {
      keyword: "mapp.api.weibo",
      pattern: /mapp\.api\.weibo\.cn\/fx\/[0-9A-Za-z]+\.html/,
      method: "parseMapp",
    },
    {
      keyword: "weibo.com/ttarticle",
      pattern: /id=(?<id>\d+)/,
      method: "parseArticleMatch",
    },
    {
      keyword: "weibo.com/article",
      pattern: /\/id\/(?<id>\d+)/,
      method: "parseArticleMatch",
    },
    {
      keyword: "weibo.com",
      pattern: /weibo\.com\/\d+\/(?<wid>[0-9a-zA-Z]+)/,
      method: "parseStatusMatch",
    },
  ]

  constructor() {
    super()
    this.headers = {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      referer: "https://weibo.com/",
    }
  }

  parseTv(match) {
    return this.parseStatus(midToId(match.groups.mid))
  }

  parseFidMatch(match) {
    return this.parseFid(match.groups.fid)
  }

  parseStatusMatch(match) {
    return this.parseStatus(match.groups.wid)
  }

  parseArticleMatch(match) {
    return this.parseArticle(match.groups.id)
  }

  async parseMapp(match) {
    return this.parseWithRedirect(`https://${match[0]}`)
  }

  async parseArticle(id) {
    const url = new URL("https://card.weibo.com/article/m/aj/detail")
    url.searchParams.set("_rid", crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex"))
    url.searchParams.set("id", id)
    url.searchParams.set("_t", Date.now())
    const detail = await http.json(url, { headers: this.headers })
    if (detail.msg !== "success") throw new ParseError("请求失败")
    const data = detail.data
    const $ = load(data.content || "")
    const graphics = []
    $("p,img").each((_, element) => {
      if (element.tagName === "p") {
        const text = $(element).text().trim().replace(/\u200b/g, "")
        if (text) graphics.push(text)
      } else {
        const src = $(element).attr("src")
        if (src) graphics.push(this.createImage(src))
      }
    })
    return this.result({
      contentId: id,
      url: data.url,
      title: data.title,
      author: this.createAuthor(data.userinfo?.screen_name, data.userinfo?.profile_image_url),
      timestamp: data.create_at_unix,
      graphics,
    })
  }

  async parseFid(fid) {
    const endpoint = `https://h5.video.weibo.com/api/component?page=/show/${fid}`
    const headers = {
      referer: `https://h5.video.weibo.com/show/${fid}`,
      "content-type": "application/x-www-form-urlencoded",
      ...this.headers,
    }
    const payload = `data=${JSON.stringify({ Component_Play_Playinfo: { oid: fid } })}`
    const wrapper = await http.json(endpoint, {
      method: "POST",
      headers,
      body: payload,
    })
    const info = wrapper.data?.Component_Play_Playinfo
    if (!info) throw new ParseError("微博视频数据为空")
    const user = info.reward?.user || {}
    const values = Object.values(info.urls || {})
    const stream = values[0] ? `https:${values[0]}` : info.stream_url
    return this.result({
      contentId: fid,
      author: this.createAuthor(user.name, user.profile_image_url, user.description),
      title: info.title,
      text: showText(info.text),
      contents: [
        this.createVideo(
          stream,
          info.cover_image ? `https:${info.cover_image}` : info.cover_image,
          info.duration_time,
        ),
      ],
      timestamp: info.real_date,
    })
  }

  async parseStatus(weiboId) {
    const headers = {
      accept: "application/json, text/plain, */*",
      referer: `https://m.weibo.cn/detail/${weiboId}`,
      origin: "https://m.weibo.cn",
      "x-requested-with": "XMLHttpRequest",
      "mweibo-pwa": "1",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      ...this.headers,
      cookie: "",
    }
    const url = `https://m.weibo.cn/statuses/show?id=${weiboId}&_=${Date.now()}`
    const response = await http.request(url, {
      headers,
      redirect: "manual",
      allowError: true,
    })
    if (response.status !== 200) {
      if ([403, 418].includes(response.status)) {
        throw new ParseError(`被风控拦截(${response.status}), 可尝试更换 UA/Referer 或稍后重试`)
      }
      throw new ParseError(`获取数据失败 ${response.status}`)
    }
    const type = response.headers.get("content-type") || ""
    if (!type.includes("application/json")) {
      throw new ParseError(`获取数据失败 content-type is not application/json (got: ${type})`)
    }
    const wrapper = JSON.parse(await response.text())
    if (!wrapper?.data) {
      throw new ParseError(wrapper?.msg || wrapper?.message || "微博内容不存在或暂不可访问")
    }
    return this.collectStatus(wrapper.data)
  }

  collectStatus(data) {
    if (!data || typeof data !== "object") {
      throw new ParseError("微博内容不存在或暂不可访问")
    }
    const page = data.page_info || {}
    const urls = page.urls || {}
    const videoUrl = urls.mp4_720p_mp4 || urls.mp4_hd_mp4 || urls.mp4_ld_mp4
    const result = this.result({
      contentId: data.idstr || data.id || data.bid || null,
      title: page.title || null,
      text: statusText(data.text),
      author: this.createAuthor(data.user?.screen_name, data.user?.profile_image_url),
      timestamp: Math.floor(new Date(data.created_at).getTime() / 1000),
      url: `https://weibo.com/${data.user?.id}/${data.bid}`,
    })
    if (videoUrl) {
      result.video = this.createVideo(
        videoUrl,
        page.page_pic?.url,
        page.media_info?.duration,
      )
    }
    result.contents.push(
      ...this.createImages((data.pics || []).map(item => item.large?.url).filter(Boolean)),
    )
    if (data.retweeted_status) result.repost = this.collectStatus(data.retweeted_status)
    return result
  }
}
