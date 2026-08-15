import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { IOS_HEADERS, COMMON_HEADERS } from "../core/utils.js"
import { log } from "../core/logger.js"

function initialState(html) {
  const matched = /window\.__INITIAL_STATE__=(.*?)<\/script>/.exec(html)
  if (!matched) throw new ParseError("小红书分享链接失效或内容已删除")
  return JSON.parse(matched[1].replace(/undefined/g, "null"))
}

export function selectXhsVideo(video) {
  const stream = video?.media?.stream || {}
  for (const codec of ["h265", "h264", "av1", "h266"]) {
    const item = stream[codec]?.[0]
    if (item?.masterUrl) return [item.masterUrl, Number(item.duration || 0) / 1000]
  }
  return [null, 0]
}

export class XiaohongshuParser extends BaseParser {
  static platform = { name: "xiaohongshu", displayName: "小红书" }
  static handlers = [
    {
      keyword: "xhslink",
      pattern: /xhslink\.(?:com|cn)\/[A-Za-z0-9._?%&+=/#@-]+/,
      method: "parseShort",
    },
    {
      keyword: "xiaohongshu.com",
      pattern:
        /(?:explore|discovery\/item)\/(?<query>(?<xhsId>[0-9a-zA-Z]+)\?[A-Za-z0-9._%&+=/#@-]+)/,
      method: "parseCommon",
    },
  ]

  constructor() {
    super()
    this.headers = {
      ...COMMON_HEADERS,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    }
    this.discoveryHeaders = {
      ...IOS_HEADERS,
      origin: "https://www.xiaohongshu.com",
      "x-requested-with": "XMLHttpRequest",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    }
    if (config.parser_xhs_ck) {
      this.headers.cookie = config.parser_xhs_ck
      this.discoveryHeaders.cookie = config.parser_xhs_ck
    }
  }

  syncConfigHeaders() {
    for (const headers of [this.headers, this.discoveryHeaders]) {
      if (config.parser_xhs_ck) headers.cookie = config.parser_xhs_ck
      else delete headers.cookie
    }
  }

  async parseShort(match) {
    this.syncConfigHeaders()
    const redirected = await this.getRedirectUrl(`https://${match[0]}`, this.discoveryHeaders)
    const parsed =
      /(?:explore|discovery\/item)\/(?<query>(?<xhsId>[0-9a-zA-Z]+)\?[A-Za-z0-9._%&+=/#@-]+)/.exec(
        redirected,
      )
    if (!parsed) throw new ParseError("小红书短链重定向地址无法识别")
    return this.parseCommon(parsed)
  }

  async parseCommon(match) {
    this.syncConfigHeaders()
    const { query, xhsId } = match.groups
    try {
      return await this.parseExplore(`https://www.xiaohongshu.com/explore/${query}`, xhsId)
    } catch (error) {
      log.warn(`[parser] parse_explore failed: ${error.message}, fallback to discovery`)
      return this.parseDiscovery(
        `https://www.xiaohongshu.com/discovery/item/${query}`,
        xhsId,
      )
    }
  }

  async parseExplore(url, xhsId) {
    const response = await http.request(url, {
      headers: this.headers,
      redirect: "manual",
      allowError: true,
    })
    if (response.status > 400) {
      throw new ParseError(`HTTP ${response.status}`)
    }
    const state = initialState(await response.text())
    const note = state.note?.noteDetailMap?.[xhsId]?.note
    if (!note) throw new ParseError(`can't find note detail for xhs_id: ${xhsId}`)
    const result = this.result({
      contentId: xhsId,
      author: this.createAuthor(note.user?.nickname, note.user?.avatar),
      title: note.title,
      text: note.desc,
    })
    if (note.type === "video" && note.video) {
      const [videoUrl, duration] = selectXhsVideo(note.video)
      if (!videoUrl) throw new ParseError("小红书视频流为空")
      result.video = this.createVideo(videoUrl, note.imageList?.[0]?.urlDefault, duration)
    } else {
      result.contents.push(
        ...this.createImages((note.imageList || []).map(item => item.urlDefault).filter(Boolean)),
      )
    }
    return result
  }

  async parseDiscovery(url, xhsId = null) {
    const html = await http.text(url, {
      headers: this.discoveryHeaders,
      redirect: "follow",
    })
    const state = initialState(html)
    const container = state.noteData
    const note = container?.data?.noteData
    const preload = container?.normalNotePreloadData
    if (!note) throw new ParseError("小红书 Discovery 数据为空")
    const result = this.result({
      contentId: xhsId,
      author: this.createAuthor(note.user?.nickName, note.user?.avatar),
      title: note.title,
      text: note.desc,
      timestamp: Math.floor(Number(note.time || 0) / 1000),
    })
    const images = (note.imageList || []).map(item => item.url).filter(Boolean)
    if (note.type === "video" && note.video) {
      const [videoUrl, duration] = selectXhsVideo(note.video)
      if (!videoUrl) throw new ParseError("小红书视频流为空")
      const cover = preload
        ? preload.imagesList[0].urlSizeLarge || preload.imagesList[0].url
        : images[0]
      result.video = this.createVideo(videoUrl, cover, duration)
    } else {
      result.contents.push(...this.createImages(images))
    }
    return result
  }
}
