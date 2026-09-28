import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { OpenGraphParser, cleanText, richHtml } from "./shared.js"

const REFERER = { referer: "https://m.douban.com/" }

function timestamp(value) {
  if (!value) return null
  const parsed = Date.parse(String(value).replace(" ", "T") + (String(value).includes("T") ? "" : "+08:00"))
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
}

function photoUrl(photo) {
  return photo?.image?.large?.url || photo?.large?.url || photo?.url || null
}

function parseHtml(parser, html) {
  return richHtml(parser, html, "https://m.douban.com/", { headers: REFERER })
}

function buildAuthor(parser, item, location = null) {
  const value = item?.author || item || {}
  return parser.createAuthor(value.name || "", value.avatar, null, REFERER, {
    id: value.uid || value.id,
    location,
  })
}

function buildComment(parser, item) {
  return parser.createComment({
    author: buildAuthor(parser, item, item.ip_location),
    content: [cleanText(item.text), ...(item.photos || []).map(photo =>
      parser.createGraphic(photoUrl(photo), null, { headers: REFERER }),
    )].filter(Boolean),
    timestamp: timestamp(item.create_time),
    stats: parser.createStats({ likeCount: item.vote_count }),
  })
}

function buildComments(parser, payload) {
  const rows = [...(payload?.popular_comments || []), ...(payload?.comments || [])]
  const roots = []
  const nodes = new Map()
  for (const row of rows) {
    if (!row?.id || nodes.has(String(row.id))) continue
    const node = buildComment(parser, row)
    nodes.set(String(row.id), node)
    const parent = row.ref_comment && nodes.get(String(row.ref_comment.id))
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots.slice(0, config.parser_max_comments)
}

export class DoubanApiParser extends OpenGraphParser {
  static platform = { name: "douban", displayName: "豆瓣" }
  static handlers = [{
    keyword: "douban.com/group/topic/",
    pattern: /(?:www\.|m\.)?douban\.com\/group\/topic\/\d+[^\s<]*/i,
    method: "parse",
  }]

  async parse(match) {
    const topicId = /topic\/(\d+)/.exec(match[0])?.[1]
    if (!topicId) return super.parse(match)
    try {
      const post = await http.json("https://m.douban.com/rexxar/api/v2/group/topic/" + topicId, {
        headers: REFERER,
      })
      const content = parseHtml(this, post.content)
      if (post.image_layout === "horizontal") {
        content.push(...(post.photos || []).map(photo => photoUrl(photo)).filter(Boolean).map(url =>
          this.createGraphic(url, null, { headers: REFERER }),
        ))
      }
      let comments = []
      if (config.parser_max_comments > 0) try {
        const payload = await http.json(
          "https://m.douban.com/rexxar/api/v2/group/topic/" + topicId + "/comments",
          { params: { count: config.parser_max_comments }, headers: REFERER },
        )
        comments = buildComments(this, payload)
      } catch {}
      const result = this.result({
        contentId: post.id || topicId,
        author: buildAuthor(this, post, post.ip_location),
        title: cleanText(post.title),
        content,
        text: content.filter(item => typeof item === "string").join("\n"),
        timestamp: timestamp(post.update_time || post.edit_time || post.create_time),
        url: post.url || "https://www.douban.com/group/topic/" + topicId + "/",
        stats: this.createStats({
          likeCount: post.like_count,
          shareCount: post.reshares_count,
          commentCount: post.comments_count,
        }),
        comments,
      })
      if (post.video_info?.url) {
        result.content.push(this.createVideo(post.video_info.url, post.cover_url, post.video_info.duration, {
          headers: REFERER,
        }))
      }
      return result
    } catch {
      return super.parse(match)
    }
  }
}
