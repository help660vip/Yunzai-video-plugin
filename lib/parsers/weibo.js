import { load } from "cheerio"

import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { config } from "../core/config.js"
import { COMMON_HEADERS } from "../core/utils.js"
import { cleanText, htmlToText, richHtml, textStickers } from "./shared.js"
import { weiboSession } from "./weibo-session.js"

function statusText(value) {
  if (!String(value || "").includes("<")) return cleanText(value)
  const $ = load(value || "")
  $("img[alt]").each((_, image) => $(image).replaceWith($(image).attr("alt")))
  return htmlToText($.html(), "https://weibo.com/")
}

function mediaUrl(value) {
  if (value && typeof value === "object") value = value.url
  if (typeof value !== "string" || !value) return null
  return value.startsWith("//") ? "https:" + value : /^https?:\/\//i.test(value) ? value : null
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
      ...COMMON_HEADERS,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      referer: "https://weibo.com/",
    }
    this.session = weiboSession
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

  authorFrom(user = {}, location = null) {
    return this.createAuthor(user.screen_name || user.name || "微博用户",
      mediaUrl(user.avatar_hd || user.profile_image_url || user.avatar), user.description,
      this.headers, { id: user.idstr || user.id, location })
  }

  pictures(data) {
    const items = data.pic_infos ? Object.values(data.pic_infos) : (data.pics || [])
    return items.flatMap(item => {
      const image = mediaUrl(item.original || item.large || item.url)
      if (!image) return []
      const key = "weibo:pic:" + (item.pic_id || new URL(image).pathname)
      const video = mediaUrl(item.video || item.videoSrc)
      return [video
        ? this.createLivePhoto(video, image, null, 1, { cacheKey: key })
        : this.createImage(image, null, this.headers, { cacheKey: key })]
    })
  }

  commentFrom(data, depth = 0) {
    const user = data.user || data.user_info || {}
    return this.createComment({
      author: this.authorFrom(user, data.source),
      content: [...textStickers(this, statusText(data.text || data.content), "weibo"), ...this.pictures(data)],
      timestamp: data.created_at_unix || Math.floor(new Date(data.created_at).getTime() / 1000),
      stats: this.createStats({ likes: data.like_count ?? data.like_counts }),
      replies: depth < 3 && Array.isArray(data.comments)
        ? data.comments.slice(0, config.parser_max_comments).map(item => this.commentFrom(item, depth + 1)) : [],
    })
  }

  async fetchComments(url, params) {
    if (config.parser_max_comments === 0) return []
    try {
      const wrapper = await this.session.json(url, { params })
      const values = wrapper.data?.data || wrapper.data?.comments || wrapper.data || []
      return Array.isArray(values)
        ? values.slice(0, config.parser_max_comments).map(item => this.commentFrom(item)) : []
    } catch { return [] }
  }

  async parseArticle(id) {
    const detail = await this.session.json("https://card.weibo.com/article/m/aj/detail", { params: { id } })
    if (!detail.data || (detail.msg && detail.msg !== "success")) throw new ParseError("微博文章暂不可访问")
    const data = detail.data
    const content = richHtml(this, data.content || "", "https://weibo.com/", { headers: this.headers })
    const comments = await this.fetchComments("https://card.weibo.com/article/m/aj/comment", { id })
    return this.result({
      contentId: id, url: data.url || "https://card.weibo.com/article/m/show/id/" + id,
      title: data.title, author: this.authorFrom(data.userinfo, data.region_info?.region_name),
      timestamp: data.create_at_unix, content, graphics: content,
      stats: this.createStats({ views: data.read_count }), comments,
    })
  }

  async parseFid(fid) {
    const wrapper = await this.session.json("https://weibo.com/tv/api/component", {
      method: "POST", params: { page: "/show/" + fid },
      body: new URLSearchParams({ data: JSON.stringify({ Component_Play_Playinfo: { oid: fid } }) }),
    })
    const info = wrapper.data?.Component_Play_Playinfo
    if (!info) throw new ParseError("微博视频数据为空")
    const stream = mediaUrl(Object.values(info.urls || {}).find(Boolean) || info.stream_url)
    if (!stream) throw new ParseError("微博视频地址暂不可用")
    const user = info.reward?.user || { id: info.author_id, name: info.author, avatar: info.avatar }
    return this.result({
      contentId: fid, url: "https://h5.video.weibo.com/show/" + fid,
      author: this.authorFrom(user, info.ip_info_str), title: info.title,
      text: statusText(info.text),
      content: [statusText(info.text), this.createVideo(stream, mediaUrl(info.cover_image), info.duration_time,
        { cacheKey: "weibo:" + fid })].filter(Boolean),
      timestamp: info.real_date,
      stats: this.createStats({ views: info.play_count, likes: info.attitudes_count,
        comments: info.comments_count, shares: info.reposts_count }),
      comments: await this.fetchComments("https://weibo.com/ajax/statuses/buildComments", {
        id: fid.split(":").at(-1), count: 20, expand_text: 1, is_show_bulletin: 2,
      }),
    })
  }

  async parseStatus(weiboId) {
    let data
    let desktopError
    try {
      const wrapper = await this.session.json("https://www.weibo.com/ajax/statuses/show", { params: { id: weiboId } })
      data = wrapper.data || (wrapper.user ? wrapper : null)
      if (!data) desktopError = new ParseError(wrapper.msg || wrapper.message || "微博内容不存在或暂不可访问")
    } catch (error) { desktopError = error }
    if (!data) {
      try {
        const wrapper = await this.session.json("https://m.weibo.cn/statuses/show", { params: { id: weiboId } })
        data = wrapper.data
        if (!data) throw new ParseError(wrapper.msg || wrapper.message || "微博内容不存在或暂不可访问")
      } catch (error) { throw desktopError || error }
    }
    await this.hydrateStatus(data)
    const result = this.collectStatus(data)
    result.comments = await this.fetchComments("https://m.weibo.cn/comments/hotflow", {
      mid: data.idstr || data.id || weiboId,
    })
    return result
  }

  async hydrateStatus(data, depth = 0) {
    if (depth > 10) throw new ParseError("微博转发层级过多")
    if (data.isLongText && (data.idstr || data.id)) {
      try {
        const wrapper = await this.session.json("https://m.weibo.cn/statuses/extend", {
          params: { id: data.idstr || data.id },
        })
        const full = wrapper.data?.longTextContent || wrapper.data?.longText || wrapper.data?.text
        if (full) data.text_raw = statusText(full)
      } catch { /* A failed optional long-text request must not hide the post. */ }
    }
    if (data.retweeted_status) await this.hydrateStatus(data.retweeted_status, depth + 1)
  }

  collectStatus(data, depth = 0) {
    if (!data || typeof data !== "object") throw new ParseError("微博内容不存在或暂不可访问")
    if (depth > 10) throw new ParseError("微博转发层级过多")
    const page = data.page_info || {}
    const urls = page.urls || {}
    const videoUrl = mediaUrl(page.media_info?.stream_url_hd || page.media_info?.stream_url ||
      urls.mp4_720p_mp4 || urls.mp4_hd_mp4 || urls.mp4_ld_mp4)
    const text = statusText(data.text_raw ?? data.text).replace(/ https?:\/\/t\.cn\/\S+\u200b?$/, "").trim()
    const content = textStickers(this, text, "weibo")
    const contents = this.pictures(data)
    if (videoUrl) contents.unshift(this.createVideo(videoUrl, mediaUrl(page.page_pic),
      page.media_info?.duration, { cacheKey: "weibo:" + (data.idstr || data.id) }))
    // A music/link card may deliberately have no playable stream.
    if (!videoUrl && page.page_url) content.push(this.createLink(page.page_url, {
      title: page.page_title || page.title, previewUrl: mediaUrl(page.page_pic),
    }))
    const id = data.idstr || data.id || data.bid || null
    const userId = data.user?.idstr || data.user?.id
    const result = this.result({
      contentId: id, title: page.title || null, text,
      author: this.authorFrom(data.user, data.region_name),
      timestamp: Math.floor(new Date(data.created_at).getTime() / 1000),
      url: userId && id ? "https://weibo.com/" + userId + "/" + (data.bid || id) : null,
      content: [...content, ...contents], contents,
      stats: this.createStats({ likes: data.attitudes_count, shares: data.reposts_count, comments: data.comments_count }),
    })
    if (data.retweeted_status) result.repost = this.collectStatus(data.retweeted_status, depth + 1)
    return result
  }
}
