import { BaseParser, matchUrl } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { config } from "../core/config.js"
import { IOS_HEADERS, ANDROID_HEADERS, pickUrl, randomChoice } from "../core/utils.js"
import { log } from "../core/logger.js"

const REFERER_HEADERS = { ...IOS_HEADERS, referer: "https://www.douyin.com/" }
const WEB_RID_RE = /\\?"webRid\\?"\s*:\s*\\?"(\d+)\\?"/

function videoDataFromRouter(data) {
  const loader = data?.loaderData || {}
  const page = loader["video_(id)/page"] || loader["note_(id)/page"]
  const items = page?.videoInfoRes?.item_list || []
  if (!items.length) throw new ParseError("can't find data in videoInfoRes")
  return randomChoice(items)
}

function avatarUrl(author = {}) {
  return pickUrl(author.avatar_thumb) || pickUrl(author.avatar_medium)
}

function playUrl(video = {}) {
  const uri = video?.play_addr?.uri
  return (
    pickUrl(video?.play_addr) ||
    (uri
      ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=1080p&line=0`
      : null)
  )
}

function cleanShareText(aweme = {}) {
  const info = aweme.share_info || {}
  const value = info.share_desc_info || aweme.desc || info.share_desc || ""
  return info.share_desc ? value.replace("#" + info.share_desc + "#", "", 1).trim() : value
}

function stickerText(parser, value, platform = "douyin") {
  const output = []
  const text = String(value || "").replace(/\[图片表情\]/g, "")
  let cursor = 0
  const pattern = /\[([^\]]+)\]/g
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index))
    output.push(parser.createSticker(
      `https://sticker.sokoko.org/assets/${encodeURIComponent(platform)}/${encodeURIComponent(match[1])}.webp`,
      "small",
      match[1],
      { cacheKey: `sticker:${platform}:${match[1]}` },
    ))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.filter(Boolean)
}

export class DouyinParser extends BaseParser {
  static platform = { name: "douyin", displayName: "抖音" }
  static handlers = [
    {
      keyword: "v.douyin",
      pattern: /v\.douyin\.com\/[a-zA-Z0-9_-]+/,
      method: "parseShort",
    },
    {
      keyword: "jx.douyin",
      pattern: /jx\.douyin\.com\/[a-zA-Z0-9_-]+/,
      method: "parseShort",
    },
    {
      keyword: "webcast.amemv.com",
      pattern: /douyin\/webcast\/reflow\/(\d+)/,
      method: "parseLiveByRoomId",
    },
    {
      keyword: "live.douyin.com",
      pattern: /live\.douyin\.com\/(\d+)/,
      method: "parseLive",
    },
    {
      keyword: "douyin",
      pattern: /douyin\.com\/(?<ty>video|note|slides)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "iesdouyin",
      pattern: /iesdouyin\.com\/share\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "m.douyin",
      pattern: /m\.douyin\.com\/share\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
    {
      keyword: "jingxuan.douyin",
      pattern: /jingxuan\.douyin\.com\/m\/(?<ty>slides|video|note)\/(?<vid>\d+)/,
      method: "parseCommon",
    },
  ]

  constructor() {
    super()
    this.headers = { ...REFERER_HEADERS }
    this.ttwid = ""
    this.ttwidTask = null
  }

  async ensureTtwid() {
    if (this.ttwid) return this.ttwid
    if (this.ttwidTask) return this.ttwidTask
    this.ttwidTask = (async () => {
      const response = await http.request(
        "https://ttwid.bytedance.com/ttwid/union/register/",
        {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/json" },
          body: {
            region: "cn",
            aid: 1768,
            needFid: false,
            service: "www.douyin.com",
            migrate_info: { ticket: "", source: "node" },
            cbUrlProtocol: "https",
            union: true,
          },
        },
      )
      const cookies = response.headers.raw?.()["set-cookie"] || [
        response.headers.get("set-cookie") || "",
      ]
      const match = /(?:^|[;,]\s*)ttwid=([^;,]+)/.exec(cookies.join(";"))
      if (!match) throw new ParseError("抖音 ttwid 注册成功但未返回 cookie")
      this.ttwid = match[1]
      return this.ttwid
    })().finally(() => {
      this.ttwidTask = null
    })
    return this.ttwidTask
  }

  async parseShort(match) {
    const source = `https://${match[0]}`
    const response = await http.request(source, {
      headers: this.headers,
      redirect: "follow",
      allowError: true,
    })
    const finalUrl = response.url || source
    const route = matchUrl(finalUrl, this.constructor)
    if (!route || route.method === "parseShort") {
      throw new ParseError("抖音短链未重定向到可识别内容")
    }
    return this[route.method](route.match, route)
  }

  async parseLiveByRoomId(match) {
    const ttwid = await this.ensureTtwid()
    const roomId = match[1]
    const html = await http.text(
      `https://webcast.amemv.com/douyin/webcast/reflow/${roomId}`,
      { headers: this.headers, cookies: { ttwid } },
    )
    const webRid = WEB_RID_RE.exec(html)?.[1]
    if (!webRid) throw new ParseError("提取抖音直播 web_rid 失败")
    return this.parseWebRid(webRid)
  }

  async parseLive(match) {
    await this.ensureTtwid()
    return this.parseWebRid(match[1])
  }

  async parseWebRid(webRid) {
    const ttwid = await this.ensureTtwid()
    const payload = await http.json("https://live.douyin.com/webcast/room/web/enter/", {
      headers: this.headers,
      params: {
        aid: 6383,
        device_platform: "web",
        browser_language: "zh-CN",
        browser_platform: "Win32",
        browser_name: "Chrome",
        browser_version: "95.0.4638.69",
        web_rid: webRid,
      },
      cookies: { ttwid },
    })
    const room = payload?.data?.data?.[0]
    if (!room) throw new ParseError("获取抖音直播间信息失败")
    const cover = pickUrl(room.cover)
    const content = []
    if (cover) content.push(this.createImage(cover))
    content.push(Number(room.status) === 2 ? "直播中" : "未开播")
    return this.result({
      contentId: room.id_str || webRid,
      author: this.createAuthor(
        room.owner?.nickname || "",
        pickUrl(room.owner?.avatar_thumb),
        null,
        this.headers,
        { id: room.owner?.id_str },
      ),
      title: room.title,
      content,
      url: `https://live.douyin.com/${webRid}`,
      stats: this.createStats({
        views: room.room_view_stats?.display_value,
        likes: room.like_count,
      }),
      extra: { content_type: "直播" },
    })
  }

  async parseCommon(match) {
    const { ty, vid } = match.groups
    try {
      return await this.parseWork(vid)
    } catch (error) {
      log.warn(`[parser] 抖音 Web API 解析失败，回退分享页: ${error.message}`)
    }
    if (ty === "slides") return this.parseSlides(vid)
    for (const url of [
      `https://m.douyin.com/share/${ty}/${vid}`,
      `https://www.iesdouyin.com/share/${ty}/${vid}`,
    ]) {
      try {
        return await this.parseVideoPage(url)
      } catch (error) {
        log.warn(`[parser] failed to parse ${url}: ${error.message}`)
      }
    }
    throw new ParseError("分享已删除或资源直链提取失败, 请稍后再试")
  }

  async parseWork(awemeId) {
    const ttwid = await this.ensureTtwid()
    const payload = await http.json("https://www.douyin.com/aweme/v1/web/aweme/detail/", {
      headers: this.headers,
      params: {
        aweme_id: awemeId,
        aid: 6383,
        device_platform: "webapp",
        channel: "channel_pc_web",
        request_source: 0,
      },
      cookies: { ttwid },
    })
    const aweme = payload?.aweme_detail
    if (!aweme) throw new ParseError("抖音作品 API 未返回内容")
    let comments = []
    try {
      const response = await http.json("https://www.douyin.com/aweme/v1/web/comment/list/", {
        headers: this.headers,
        params: {
          device_platform: "webapp",
          aid: 6383,
          channel: "channel_pc_web",
          aweme_id: awemeId,
          cursor: 0,
          count: config.parser_max_comments,
          msToken: "",
          "X-Bogus": "",
        },
        cookies: { ttwid },
      })
      comments = (response?.comments || response?.comment_list || [])
        .slice(0, config.parser_max_comments)
        .map(item => this.buildComment(item))
    } catch (error) {
      log.warn(`[parser] 抖音获取评论失败: ${error.message}`)
    }
    return this.buildWorkResult(aweme, comments)
  }

  buildComment(comment) {
    const content = stickerText(this, comment.text)
    for (const image of comment.image_list || []) {
      const url = pickUrl(image.origin_url)
      if (url) content.push(this.createImage(url))
    }
    const sticker = pickUrl(comment.sticker?.static_url)
    if (sticker) content.push(this.createSticker(sticker, "small"))
    return this.createComment({
      author: this.createAuthor(
        comment.user?.nickname || "",
        avatarUrl(comment.user),
        null,
        this.headers,
        { id: comment.user?.uid, location: comment.ip_label },
      ),
      content,
      timestamp: comment.create_time,
      stats: this.createStats({
        likes: comment.digg_count,
        comments: comment.reply_comment_total,
      }),
    })
  }

  buildWorkResult(aweme, comments = []) {
    const awemeId = aweme.aweme_id
    const content = []
    const text = cleanShareText(aweme)
    if (text) content.push(text)
    let musicUrl = null
    if (aweme.music && aweme.music.is_original_sound === false) {
      musicUrl = pickUrl(aweme.music.play_url) || aweme.music.play_url?.uri || null
      if (!musicUrl && aweme.music.extra) {
        try {
          musicUrl = JSON.parse(aweme.music.extra).original_song_url || null
        } catch {}
      }
      if (musicUrl) {
        content.push(
          this.createAudio(musicUrl, aweme.music.duration, {
            headers: REFERER_HEADERS,
            cacheKey: "douyin:" + (aweme.music.mid || awemeId) + ":music",
          }),
        )
      }
    }
    if (aweme.images?.length) {
      for (const image of aweme.images) {
        const cacheKey = image.uri ? `douyin:${awemeId}:${image.uri}` : null
        if ((image.clip_type === null || image.clip_type === undefined || image.clip_type === 2)) {
          const url = pickUrl(image)
          if (url) content.push(this.createImage(url, null, REFERER_HEADERS))
        } else if (image.video) {
          const videoUrl = playUrl(image.video)
          const cover = pickUrl(image.video.cover) || pickUrl(image)
          if (videoUrl && cover) {
            content.push(
              this.createLivePhoto(videoUrl, cover, musicUrl, 3, {
                headers: REFERER_HEADERS,
                cacheKey,
              }),
            )
          }
        }
      }
    } else if (aweme.video) {
      const url = playUrl(aweme.video)
      if (url) {
        content.push(
          this.createVideo(
            url,
            pickUrl(aweme.video.cover),
            Math.floor(Number(aweme.video.duration || 0) / 1000),
            { headers: REFERER_HEADERS, cacheKey: "douyin:" + awemeId },
          ),
        )
      }
    }
    return this.result({
      contentId: awemeId,
      author: this.createAuthor(
        aweme.author?.nickname || "",
        avatarUrl(aweme.author),
        aweme.author?.signature,
        REFERER_HEADERS,
        { id: aweme.author?.uid, location: aweme.region },
      ),
      text,
      content,
      timestamp: aweme.create_time,
      url: aweme.share_url
        ? String(aweme.share_url).split("?")[0]
        : awemeId
          ? `https://www.douyin.com/video/${awemeId}`
          : null,
      stats: this.createStats({
        likes: aweme.statistics?.digg_count || aweme.stats?.digg_count,
        comments: aweme.statistics?.comment_count || aweme.stats?.comment_count,
        shares: aweme.statistics?.share_count || aweme.stats?.share_count,
        collects: aweme.statistics?.collect_count || aweme.stats?.collect_count,
      }),
      comments,
      embedUrl: `https://open.douyin.com/player/video?vid=${awemeId}&autoplay=1`,
    })
  }

  async parseVideoPage(url) {
    const response = await http.request(url, {
      headers: IOS_HEADERS,
      redirect: "manual",
      allowError: true,
      verify: false,
    })
    if (response.status !== 200) throw new ParseError(`status: ${response.status}`)
    const html = await response.text()
    const matched = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s.exec(html)
    if (!matched?.[1]) throw new ParseError("can't find _ROUTER_DATA in html")
    const data = videoDataFromRouter(JSON.parse(matched[1].trim()))
    return this.buildWorkResult(data)
  }

  async parseSlides(videoId) {
    const url = new URL("https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/")
    url.searchParams.set("aweme_ids", `[${videoId}]`)
    url.searchParams.set("request_source", "200")
    const data = await http.json(url, { headers: ANDROID_HEADERS, verify: false })
    const slides = data?.aweme_details?.[0]
    if (!slides) throw new ParseError("can't find slides data")
    return this.buildWorkResult(slides)
  }
}
