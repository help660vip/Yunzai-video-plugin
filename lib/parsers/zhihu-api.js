import * as cheerio from "cheerio"

import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { OpenGraphParser, cleanText, anchorText, HTML_NEWLINE_TAGS, textStickers } from "./shared.js"

function cookieValue(cookie, name) {
  return String(cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(name + "="))?.slice(name.length + 1) || ""
}

function headers(referer) {
  const cookie = config.parser_zhihu_ck || ""
  return {
    referer,
    "x-requested-with": "fetch",
    ...(cookie ? { cookie } : {}),
    ...(cookieValue(cookie, "d_c0") ? { "x-zse-93": "101_3_3.0" } : {}),
  }
}

async function fetchVideo(parser, videoId, contentType, referer) {
  try {
    const data = await http.json("https://www.zhihu.com/api/v4/video/play_info", {
      method: "POST",
      headers: { ...headers(referer), "x-app-za": "OS=webplayer", "x-referer": "" },
      body: {
        content_id: videoId,
        video_id: videoId,
        content_type_str: contentType,
        is_only_video: true,
        scene_code: "answer_detail_web",
      },
    })
    const play = data.video_play || {}
    const ranks = { FHD: 3, HD: 2, SD: 1 }
    const videos = play.playlist?.mp4 || []
    const best = videos.sort((a, b) => (ranks[b.quality] || 0) - (ranks[a.quality] || 0))[0]
    const url = Array.isArray(best?.url) ? best.url[0] : best?.url
    return url ? parser.createVideo(url, play.default_cover, best.duration) : null
  } catch {
    return null
  }
}

async function parseRich(parser, html, contentType, referer) {
  const $ = cheerio.load("<div id=parser-root>" + (html || "") + "</div>")
  const result = []
  let buffer = ""
  const flush = () => {
    const text = cleanText(buffer)
    if (text) result.push(text)
    buffer = ""
  }
  const walk = async node => {
    if (node.type === "text") {
      const text = String(node.data || "").replace(/\s+/g, " ")
      if (text.trim()) buffer += text
      else if (!/[\r\n]/.test(node.data || "") && buffer && !buffer.endsWith("\n")) buffer += " "
      return
    }
    if (node.type !== "tag" || node.name === "noscript") return
    const element = $(node)
    const classes = new Set(element.attr("class")?.split(/\s+/).filter(Boolean) || [])
    if (node.name === "a" && classes.has("video-box")) {
      flush()
      const video = await fetchVideo(parser, element.attr("data-lens-id"), contentType, referer)
      if (video) result.push(video)
      else if (element.attr("href")) result.push(parser.createLink(element.attr("href"), {
        title: element.attr("data-name") || "知乎视频",
      }))
      return
    }
    if (node.name === "img") {
      const src = element.attr("data-original") || element.attr("data-actualsrc") ||
        element.attr("data-default-watermark-src") || element.attr("src")
      if (src) {
        flush()
        result.push(parser.createGraphic(src, element.attr("alt"), { headers: headers(referer) }))
      }
      return
    }
    if (node.name === "a" && classes.has("comment_img")) {
      if (element.attr("href")) {
        flush()
        result.push(parser.createImage(element.attr("href")))
      }
      return
    }
    if (node.name === "a" && !element.find("img").length) {
      buffer += anchorText(element, referer) || ""
      return
    }
    if (HTML_NEWLINE_TAGS.has(node.name) && buffer && !buffer.endsWith("\n")) buffer += "\n"
    for (const child of node.children || []) await walk(child)
    if (HTML_NEWLINE_TAGS.has(node.name) && buffer && !buffer.endsWith("\n")) buffer += "\n"
  }
  for (const node of $("#parser-root").get(0)?.children || []) await walk(node)
  flush()
  return contentType === "comment" ? result.flatMap(item => typeof item === "string" ? textStickers(parser, item, "zhihu") : [item]) : result
}

function zhihuAuthor(parser, value, location, referer) {
  return parser.createAuthor(value?.name || "", value?.avatar_url, value?.headline, headers(referer), {
    id: value?.url_token || value?.id,
    location,
  })
}

function reactionStats(parser, value, fallback = {}) {
  const stats = value?.reaction?.statistics || value?.statistics || {}
  return parser.createStats({
    likeCount: stats.like_count ?? fallback.likeCount ?? value?.voteup_count,
    commentCount: stats.comment_count ?? fallback.commentCount ?? value?.comment_count,
    collectCount: stats.favorites ?? fallback.collectCount,
    viewCount: fallback.viewCount,
    extra: {
      downVote: ["反对", stats.down_vote_count],
      upVote: ["赞成", stats.up_vote_count ?? value?.voteup_count],
      ...(fallback.extra || {}),
    },
  })
}

async function fetchComments(parser, kind, id, referer) {
  if (!config.parser_max_comments) return []
  try {
    const payload = await http.json(
      "https://www.zhihu.com/api/v4/comment_v5/" + kind + "/" + id + "/root_comment",
      { params: { order_by: "score", limit: Math.min(20, config.parser_max_comments) }, headers: headers(referer) },
    )
    return await Promise.all((payload.data || []).slice(0, config.parser_max_comments).map(async row =>
      parser.createComment({
        author: zhihuAuthor(parser, row.author, (row.comment_tag || []).find(tag => tag.type === "ip_info")?.text, referer),
        content: await parseRich(parser, row.content, "comment", referer),
        timestamp: row.created_time,
        stats: parser.createStats({ likeCount: row.like_count, commentCount: row.child_comment_count }),
      }),
    ))
  } catch {
    return []
  }
}

export class ZhihuApiParser extends OpenGraphParser {
  static platform = { name: "zhihu", displayName: "知乎" }
  static handlers = [
    { keyword: "zhuanlan.zhihu.com/p", pattern: /zhuanlan\.zhihu\.com\/p\/\d+[^\s<]*/i, method: "parse" },
    { keyword: "zhihu.com/question", pattern: /(?:www\.)?zhihu\.com\/question\/\d+(?:\/answer\/\d+)?[^\s<]*/i, method: "parse" },
  ]

  async parse(match) {
    const raw = match[0]
    const articleId = /zhuanlan\.zhihu\.com\/p\/(\d+)/.exec(raw)?.[1]
    const answer = /question\/(\d+)\/answer\/(\d+)/.exec(raw)
    const questionId = answer?.[1] || /question\/(\d+)/.exec(raw)?.[1]
    const referer = "https://" + raw.replace(/^https?:\/\//, "")
    try {
      if (articleId) return await this.parseArticle(articleId, referer)
      if (answer) return await this.parseAnswer(answer[1], answer[2], referer)
      if (questionId) return await this.parseQuestion(questionId, referer)
      return super.parse(match)
    } catch {
      return super.parse(match)
    }
  }

  async api(path, referer, include) {
    return http.json("https://www.zhihu.com/api/v4/" + path, {
      params: include ? { include } : undefined,
      headers: headers(referer),
    })
  }

  async parseArticle(id, referer) {
    const value = await this.api("articles/" + id, referer,
      "content,topics,excerpt,thanks_count,voteup_count,comment_count,visited_count,reaction,ip_info,author.badge_v2")
    const content = await parseRich(this, value.content, "article", referer)
    return this.result({
      contentId: "article:" + id,
      title: cleanText(value.title),
      author: zhihuAuthor(this, value.author, value.ip_info, referer),
      content,
      text: content.filter(item => typeof item === "string").join("\n"),
      timestamp: value.updated || value.created,
      url: "https://zhuanlan.zhihu.com/p/" + id,
      stats: reactionStats(this, value),
      comments: await fetchComments(this, "articles", id, referer),
    })
  }

  async parseAnswer(questionId, id, referer) {
    const value = await this.api("answers/" + id, referer,
      "content,excerpt,thanks_count,voteup_count,comment_count,reaction,ip_info,question.topics,author.badge_v2")
    const content = await parseRich(this, value.content, "answer", referer)
    return this.result({
      contentId: "answer:" + id,
      title: cleanText(value.question?.title),
      author: zhihuAuthor(this, value.author, value.ip_info, referer),
      content,
      text: content.filter(item => typeof item === "string").join("\n"),
      timestamp: value.updated_time || value.created_time,
      url: "https://www.zhihu.com/question/" + questionId + "/answer/" + id,
      stats: reactionStats(this, value),
      comments: await fetchComments(this, "answers", id, referer),
    })
  }

  async parseQuestion(id, referer) {
    const value = await this.api("questions/" + id, referer,
      "read_count,visit_count,answer_count,voteup_count,comment_count,follower_count,detail,excerpt,author,topics")
    const content = await parseRich(this, value.detail, "question", referer)
    return this.result({
      contentId: "question:" + id,
      title: cleanText(value.title),
      author: zhihuAuthor(this, value.author, null, referer),
      content,
      text: content.filter(item => typeof item === "string").join("\n"),
      timestamp: value.updated_time || value.created,
      url: "https://www.zhihu.com/question/" + id,
      stats: reactionStats(this, value, {
        viewCount: value.visit_count ?? value.read_count,
        commentCount: value.comment_count,
        extra: { followers: ["关注", value.follower_count], answers: ["回答", value.answer_count] },
      }),
      comments: await fetchComments(this, "questions", id, referer),
    })
  }
}
