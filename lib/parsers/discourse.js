import * as cheerio from "cheerio"

import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { OpenGraphParser, absoluteUrl, cleanText, anchorText, htmlToText, HTML_NEWLINE_TAGS } from "./shared.js"

function avatarUrl(post, origin) {
  return absoluteUrl(String(post?.avatar_template || "").replace("{size}", "288"), origin)
}

function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000)
}

function author(parser, post, origin) {
  return parser.createAuthor(
    post?.display_username || post?.name || post?.username || "",
    avatarUrl(post, origin),
    null,
    { referer: origin + "/" },
    { id: post?.username },
  )
}

function pollContent(parser, poll, origin) {
  const options = (poll?.options || []).map(option => ({
    text: htmlToText(option.html || "", origin),
    votes: option.votes,
  }))
  return parser.createPoll({
    options,
    title: poll?.title,
    totalVotes: options.reduce((sum, option) => sum + (Number(option.votes) || 0), 0),
    totalVoters: poll?.voters,
    multiple: poll?.type === "multiple",
    closed: poll?.status === "closed",
    closeAt: poll?.close,
  })
}

function eventContent(parser, event, origin) {
  if (!event?.post?.url) return null
  const end = event.ends_at ? " - " + event.ends_at : ""
  return parser.createLink(absoluteUrl(event.post.url, origin), {
    title: event.name || event.post.topic?.title,
    siteName: new URL(origin).host,
    description: cleanText(event.starts_at + end + (event.timezone ? " (" + event.timezone + ")" : "")),
  })
}

export function parseDiscourseContent(parser, cooked, origin, post = {}) {
  const $ = cheerio.load("<div id=parser-root>" + (cooked || "") + "</div>")
  const result = []
  let buffer = ""
  const flush = () => {
    const text = cleanText(buffer)
    if (text) result.push(text)
    buffer = ""
  }
  const polls = new Map((post.polls || []).map(poll => [poll.name || "poll", poll]))

  const walk = node => {
    if (node.type === "text") {
      const text = String(node.data || "").replace(/\s+/g, " ")
      if (text.trim()) buffer += text
      else if (!/[\r\n]/.test(node.data || "") && buffer && !buffer.endsWith("\n")) buffer += " "
      return
    }
    if (node.type !== "tag") return
    const element = $(node)
    const classes = new Set(element.attr("class")?.split(/\s+/).filter(Boolean) || [])
    if (node.name === "aside" && classes.has("quote")) {
      flush()
      const link = element.find(".quote-title__text-content a[href]").first()
      const icon = element.find(".title img.avatar[src]").first()
      result.push(parser.createQuote(cleanText(element.find("blockquote").first().text()), {
        title: cleanText(link.text()) || cleanText(element.attr("data-display-name")) || null,
        url: absoluteUrl(link.attr("href"), origin),
        iconUrl: absoluteUrl(icon.attr("src"), origin),
      }))
      return
    }
    if (node.name === "aside" && classes.has("onebox")) {
      const source = element.find("header.source a[href]").first()
      const title = element.find(".onebox-body h3 a[href]").first()
      const url = element.attr("data-onebox-src") || title.attr("href") || source.attr("href")
      if (url) {
        flush()
        result.push(parser.createLink(absoluteUrl(url, origin), {
          title: cleanText(title.text()) || cleanText(source.text()) || null,
          siteName: cleanText(source.text()) || null,
          description: cleanText(element.find(".onebox-body p").first().text()) || null,
          iconUrl: absoluteUrl(element.find("header.source img.site-icon").attr("src"), origin),
          previewUrl: absoluteUrl(element.find(".onebox-body img.thumbnail").attr("src"), origin),
        }))
      }
      return
    }
    if (node.name === "div" && classes.has("poll")) {
      const poll = polls.get(element.attr("data-poll-name") || "poll")
      if (poll) {
        flush()
        result.push(pollContent(parser, poll, origin))
      }
      return
    }
    if (node.name === "div" && classes.has("discourse-post-event")) {
      const event = eventContent(parser, post.event, origin)
      if (event) {
        flush()
        result.push(event)
      }
      return
    }
    if (node.name === "img") {
      const src = absoluteUrl(element.attr("src") || element.attr("data-src"), origin)
      if (src) {
        flush()
        result.push(classes.has("emoji")
          ? parser.createSticker(src, "small", element.attr("alt"))
          : parser.createGraphic(src, element.attr("alt")))
      }
      return
    }
    if (node.name === "a" && !element.find("img").length) {
      buffer += anchorText(element, origin) || ""
      return
    }
    if (HTML_NEWLINE_TAGS.has(node.name) && buffer && !buffer.endsWith("\n")) buffer += "\n"
    for (const child of node.children || []) walk(child)
    if (HTML_NEWLINE_TAGS.has(node.name) && buffer && !buffer.endsWith("\n")) buffer += "\n"
  }
  for (const node of $("#parser-root").get(0)?.children || []) walk(node)
  flush()
  return result
}

class ApiDiscourseParser extends OpenGraphParser {
  async parse(match) {
    const rawUrl = /^https?:\/\//i.test(match[0]) ? match[0] : "https://" + match[0]
    const topicId = /(?:topic\/|\/t\/[^/]+\/)(\d+)/.exec(rawUrl)?.[1]
    if (!topicId) return super.parse(match)
    try {
      const data = await http.json(this.apiOrigin + "/t/topic/" + topicId + ".json", {
        headers: {
          ...this.headers,
          referer: this.apiOrigin + "/",
          ...(this.useLinuxCookie && config.parser_linuxdo_ck ? { cookie: config.parser_linuxdo_ck } : {}),
        },
      })
      const posts = data.post_stream?.posts || []
      const first = posts[0] || {}
      const result = this.result({
        contentId: data.id || topicId,
        title: cleanText(data.title),
        author: author(this, first, this.apiOrigin),
        content: parseDiscourseContent(this, first.cooked, this.apiOrigin, first),
        timestamp: timestamp(first.created_at),
        url: this.canonicalOrigin + "/topic/" + (data.id || topicId),
        stats: this.createStats({
          likeCount: data.like_count ?? first.reaction_users_count,
          commentCount: Math.max(0, Number(data.posts_count || posts.length) - 1),
          viewCount: data.views,
        }),
      })
      result.text = result.content.filter(item => typeof item === "string").join("\n")
      result.comments = posts.slice(1, config.parser_max_comments + 1).filter(post => post.cooked).map(post =>
        this.createComment({
          author: author(this, post, this.apiOrigin),
          content: parseDiscourseContent(this, post.cooked, this.apiOrigin, post),
          timestamp: timestamp(post.created_at),
          stats: this.createStats({
            likeCount: post.reaction_users_count,
            commentCount: post.reply_count,
          }),
        }),
      )
      return result
    } catch {
      return super.parse(match)
    }
  }
}

export class LinuxDoApiParser extends ApiDiscourseParser {
  static platform = { name: "linuxdo", displayName: "Linux Do" }
  static handlers = [{ keyword: "linux.do", pattern: /linux\.do\/(?:t\/[^/\s]+\/|t\/topic\/|topic\/)\d+[^\s<]*/i, method: "parse" }]
  apiOrigin = "https://linux.do"
  canonicalOrigin = "https://linux.do"
  useLinuxCookie = true
}

export class ZlbApiParser extends ApiDiscourseParser {
  static platform = { name: "zlb", displayName: "壁吧专楼吧" }
  static handlers = [{ keyword: "zlb.ink", pattern: /(?:bb\.)?zlb\.ink\/(?:t\/[^/\s]+\/|t\/topic\/|topic\/)\d+[^\s<]*/i, method: "parse" }]
  apiOrigin = "https://bb.zlb.ink"
  canonicalOrigin = "https://zlb.ink"
}
