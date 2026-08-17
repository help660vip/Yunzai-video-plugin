import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { config } from "../core/config.js"
import { IOS_HEADERS, pickUrl, randomChoice } from "../core/utils.js"

const COMMENT_API = "https://kph8gvfz.m.chenzhongtech.com/rest/wd/photo/comment/list"

function randomDid() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let value = ""
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return "web_" + value
}

function commentContent(parser, value) {
  const output = []
  const text = String(value || "")
  let cursor = 0
  for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index))
    output.push(
      parser.createSticker(
        `https://sticker.sokoko.org/assets/kuaishou/${encodeURIComponent(match[1])}.webp`,
        "small",
        match[1],
        { cacheKey: "sticker:kuaishou:" + match[1] },
      ),
    )
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.filter(Boolean)
}

export class KuaishouParser extends BaseParser {
  static platform = { name: "kuaishou", displayName: "快手" }
  static handlers = [
    {
      keyword: "v.kuaishou",
      pattern: /v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
    {
      keyword: "kuaishou",
      pattern: /(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
    {
      keyword: "chenzhongtech",
      pattern: /(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
    {
      keyword: "m.gifshow.com",
      pattern: /m\.gifshow\.com\/fw\/photo\/\d+[^\s<]*/i,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = { ...IOS_HEADERS, referer: "https://v.kuaishou.com/" }
  }

  async parse(match) {
    const source = `https://${match[0]}`
    let realUrl = await this.getRedirectUrl(source, this.headers)
    if (!realUrl) throw new ParseError("failed to get location url from url")
    realUrl = realUrl.replace("/fw/long-video/", "/fw/photo/")
    const html = await http.text(realUrl, { headers: this.headers })
    const matched = /window\.INIT_STATE\s*=\s*(.*?)<\/script>/.exec(html)
    if (!matched) throw new ParseError("failed to parse video JSON info from HTML")
    const state = JSON.parse(matched[1].trim())
    const photo = Object.values(state)
      .map(item => item?.photo)
      .find(Boolean)
    if (!photo) throw new ParseError("window.init_state don't contains videos or pics")

    const name = String(photo.userName || "未知用户").replace(/\u3164/g, "").trim()
    const content = []
    if (photo.caption) content.push(photo.caption)
    const result = this.result({
      contentId: photo.photoId || photo.id || null,
      title: photo.caption,
      text: photo.caption,
      author: this.createAuthor(name, photo.headUrl),
      timestamp: Math.floor(Number(photo.timestamp || 0) / 1000),
      url: photo.photoId || photo.id
        ? `https://m.gifshow.com/fw/photo/${photo.photoId || photo.id}`
        : null,
      content,
      stats: this.createStats({
        views: photo.viewCount,
        likes: photo.likeCount,
        comments: photo.commentCount,
        shares: photo.shareCount,
      }),
    })
    const videoUrl = pickUrl(randomChoice(photo.mainMvUrls || []))
    if (videoUrl) {
      content.push(this.createVideo(
        videoUrl,
        pickUrl(randomChoice(photo.coverUrls || [])),
        Math.floor(Number(photo.duration || 0) / 1000),
        { cacheKey: "kuaishou:" + (photo.photoId || photo.id) },
      ))
    }
    const atlas = photo.ext_params?.atlas || {}
    if (atlas.cdnList?.length && atlas.list?.length) {
      const cdn = randomChoice(atlas.cdnList)?.cdn
      if (cdn) {
        content.push(
          ...this.createImages(atlas.list.map(route => `https://${cdn}/${route}`)),
        )
      }
    }
    result.comments = await this.fetchComments(photo.photoId || photo.id)
    return result
  }

  buildComment(comment, includeReplyCount = false) {
    return this.createComment({
      author: this.createAuthor(
        comment.author_name || "",
        comment.headurl,
        null,
        this.headers,
        { id: comment.user_id, location: comment.authorArea },
      ),
      content: commentContent(this, comment.content),
      timestamp: Math.floor(Number(comment.timestamp || 0) / 1000),
      stats: this.createStats({
        likes: comment.likedCount,
        comments: includeReplyCount ? comment.subCommentCount : null,
      }),
    })
  }

  async fetchComments(photoId) {
    if (!photoId || config.parser_max_comments <= 0) return []
    try {
      const payload = await http.json(COMMENT_API, {
        method: "POST",
        headers: { ...this.headers, "content-type": "application/json" },
        cookies: { did: randomDid() },
        body: { photoId, count: config.parser_max_comments },
      })
      const data = payload?.data || payload
      return (data?.rootComments || []).slice(0, config.parser_max_comments).map(root => {
        const comment = this.buildComment(root, true)
        const replies = data?.subCommentsMap?.[String(root.comment_id)]?.subComments || []
        comment.replies.push(...replies.map(reply => this.buildComment(reply)))
        return comment
      })
    } catch {
      return []
    }
  }
}
