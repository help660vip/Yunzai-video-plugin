import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { ParseError } from "../core/errors.js"
import { PathTask } from "../core/model.js"
import { OpenGraphParser } from "./shared.js"

const ORIGIN = "https://www.taptap.cn"
const X_UA = "V=1&PN=WebApp&LANG=zh_CN&VN_CODE=93&VN=0.1.0&LOC=CN&PLT=PC"

function tapImageUrl(value, depth = 0) {
  if (depth > 5 || !value) return null
  if (typeof value === "string") return value
  for (const key of ["original_url", "original", "img", "image", "url", "img_url"]) {
    const url = tapImageUrl(value[key], depth + 1)
    if (url) return url
  }
  return null
}

export function tapContent(parser, contents) {
  const output = []
  let parts = contents?.json || []
  if (typeof parts === "string") {
    try { parts = JSON.parse(parts) } catch { parts = [] }
  }
  const append = (part, depth = 0) => {
    if (!part || depth > 32) return
    const img = tapImageUrl(part.info)
    if (part.type === "tap_emoji") {
      const desc = (part.children || []).find(child => child.text)?.text || part.text
      if (img) output.push(desc
        ? parser.createSticker(img, part.info?.style === "inline" ? "small" : "medium", desc)
        : parser.createImage(img))
      else if (desc) output.push(desc)
      return
    }
    if (part.text) output.push(part.text)
    if (img) output.push(parser.createImage(img))
    for (const child of part.children || []) append(child, depth + 1)
  }
  for (const part of parts) {
    append(part)
    if (part.type === "paragraph") output.push("\n")
  }
  return output
}

export class TapTapApiParser extends OpenGraphParser {
  static platform = { name: "taptap", displayName: "TapTap" }
  static handlers = [{
    keyword: "taptap.cn",
    pattern: /(?:www\.)?taptap\.cn\/(?:moment|explore)\/(\d+)[^\s<]*/i,
    method: "parse",
  }]

  author(value = {}) {
    return this.createAuthor(value.name || "", value.avatar, null, this.headers, {
      id: value.id, cacheKey: "taptap:author:" + value.id,
    })
  }

  comment(row, depth = 0) {
    return this.createComment({
      author: this.author(row.author),
      content: [...tapContent(this, row.contents), ...(row.images || [])
        .map(image => tapImageUrl(image)).filter(Boolean).map(url => this.createImage(url))],
      timestamp: row.created_time,
      stats: this.createStats({ likes: row.ups, comments: row.comments }),
      replies: depth < 10 ? (row.child_posts || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }

  async api(path, params) {
    return http.json(ORIGIN + "/webapiv2/" + path, {
      headers: { ...this.headers, referer: ORIGIN + "/" },
      params: { ...params, "X-UA": X_UA },
    })
  }

  async parse(match) {
    const id = match[1] || /(?:moment|explore)\/(\d+)/.exec(match[0])?.[1]
    const wrapper = await this.api("moment/v3/detail", { id })
    const data = wrapper?.data
    if (!data?.moment) throw new ParseError("TapTap 内容不存在或暂不可访问")
    const moment = data.moment
    const content = tapContent(this, data.first_post?.contents)
    const imageUrls = new Set(content.map(item => item?.pathTask?.url).filter(Boolean))
    for (const image of [
      ...(data.first_post?.footer_images || []),
      ...(data.first_post?.images || []),
      ...(moment.topic?.images || []),
    ]) {
      const url = tapImageUrl(image)
      if (url && !imageUrls.has(url)) {
        imageUrls.add(url)
        content.push(this.createImage(url))
      }
    }
    if (moment.topic?.pin_video?.video_id) {
      const videos = await this.api("video-resource/v1/multi-get", { video_ids: moment.topic.pin_video.video_id })
      for (const video of videos.data?.list || []) {
        if (!video.play_url?.url) continue
        const task = new PathTask(() => this.downloader.downloadM3u8(video.play_url.url, {
          cacheKey: "taptap:" + video.video_id, headers: this.headers,
        }))
        content.push(this.createVideo(task, video.raw_cover?.url, video.info?.duration, { isDynamicSize: true }))
      }
    }
    let comments = []
    if (config.parser_max_comments > 0) {
      try {
        const replies = await this.api("moment-comment/v1/by-moment", {
          moment_id: id, sort: "rank", order: "desc", limit: config.parser_max_comments,
        })
        comments = (replies.data?.list || []).slice(0, config.parser_max_comments).map(row => this.comment(row))
      } catch {}
    }
    return this.result({
      contentId: moment.id_str || id,
      author: this.author(moment.author?.user),
      title: moment.topic?.title,
      content,
      timestamp: moment.created_time,
      url: ORIGIN + "/moment/" + (moment.id_str || id),
      stats: this.createStats({
        views: moment.stat?.pv_total, likes: moment.stat?.ups, comments: moment.stat?.comments,
        collects: moment.stat?.favorites, shares: moment.stat?.reposts,
      }),
      comments,
    })
  }
}
