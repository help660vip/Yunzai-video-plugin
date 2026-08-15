import * as cheerio from "cheerio"

import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { BaseParser } from "../core/registry.js"

export function absoluteUrl(value, base) {
  if (!value) return null
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

export function cleanText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function firstMeta($, names) {
  for (const name of names) {
    const value =
      $(`meta[property="${name}"]`).attr("content") ||
      $(`meta[name="${name}"]`).attr("content")
    if (value) return value
  }
  return null
}

function jsonLd($) {
  const entries = []
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text())
      entries.push(...(Array.isArray(value) ? value : [value]))
    } catch {}
  })
  return entries.flatMap(value => (Array.isArray(value?.["@graph"]) ? value["@graph"] : [value]))
}

function statValue(entry, type) {
  const items = Array.isArray(entry?.interactionStatistic)
    ? entry.interactionStatistic
    : [entry?.interactionStatistic]
  const found = items.find(item => String(item?.interactionType || "").includes(type))
  return Number(found?.userInteractionCount || 0) || null
}

export class OpenGraphParser extends BaseParser {
  async parse(match) {
    const rawUrl = match[0].replace(/[),，。]+$/, "")
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl
    const response = await http.request(url, { headers: this.headers })
    const finalUrl = response.url || url
    const html = await response.text()
    return this.collectHtml(html, finalUrl)
  }

  collectHtml(html, url) {
    const $ = cheerio.load(html)
    const structured = jsonLd($).find(Boolean) || {}
    const title =
      firstMeta($, ["og:title", "twitter:title"]) ||
      structured.headline ||
      structured.name ||
      $("title").first().text()
    const text =
      firstMeta($, ["og:description", "twitter:description", "description"]) ||
      structured.articleBody ||
      structured.description ||
      $("article").first().text()
    const authorData = structured.author || structured.creator || {}
    const authorName =
      firstMeta($, ["author"]) ||
      (typeof authorData === "string" ? authorData : authorData.name) ||
      ""
    const authorAvatar =
      typeof authorData === "object"
        ? authorData.image?.url || authorData.image || authorData.thumbnailUrl
        : null
    const images = [
      firstMeta($, ["og:image", "twitter:image"]),
      ...(Array.isArray(structured.image) ? structured.image : [structured.image]),
    ]
      .map(item => absoluteUrl(typeof item === "object" ? item?.url : item, url))
      .filter(Boolean)
    const video = absoluteUrl(
      firstMeta($, ["og:video:secure_url", "og:video", "twitter:player:stream"]) ||
        structured.contentUrl,
      url,
    )
    const audio = absoluteUrl(firstMeta($, ["og:audio"]) || structured.audio?.contentUrl, url)
    const result = this.result({
      author: authorName ? this.createAuthor(authorName, authorAvatar) : null,
      title: cleanText(title),
      text: cleanText(text),
      timestamp: structured.datePublished || structured.uploadDate || null,
      url,
      stats: this.createStats({
        likes: statValue(structured, "LikeAction"),
        comments: statValue(structured, "CommentAction"),
        shares: statValue(structured, "ShareAction"),
        views: statValue(structured, "WatchAction"),
      }),
    })
    if (video) result.contents.push(this.createVideo(video, images[0]))
    else if (audio) result.contents.push(this.createAudio(audio))
    result.contents.push(...this.createImages([...new Set(images)].slice(0, 18)))
    if (!result.text) {
      const body = cleanText($("article,main,.content,.post-content").first().text())
      result.text = body.slice(0, config.parser_forward_text_threshold * 4)
    }
    return result
  }
}

export class DiscourseParser extends OpenGraphParser {
  async parse(match) {
    const rawUrl = match[0].replace(/[),，。]+$/, "")
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl
    const topicId = /(?:topic|\/t\/[^/]+)\/(\d+)/.exec(url)?.[1]
    if (!topicId) return super.parse(match)
    const origin = new URL(url).origin
    const data = await http.json(origin + "/t/topic/" + topicId + ".json", {
      headers: {
        ...this.headers,
        ...(config.parser_linuxdo_ck && origin.includes("linux.do")
          ? { cookie: config.parser_linuxdo_ck }
          : {}),
      },
    })
    const posts = data.post_stream?.posts || []
    const first = posts[0] || {}
    const result = this.result({
      title: cleanText(data.title),
      author: this.createAuthor(first.name || first.username || "", absoluteUrl(
        String(first.avatar_template || "").replace("{size}", "288"),
        origin,
      )),
      timestamp: first.created_at,
      url,
      stats: this.createStats({
        likes: first.actions_summary?.find(item => item.id === 2)?.count,
        comments: Math.max(0, Number(data.posts_count || posts.length) - 1),
        views: data.views,
      }),
    })
    const parsed = parseCooked(this, first.cooked, origin)
    result.text = parsed.text
    result.content.push(...parsed.content)
    result.comments = posts.slice(1, config.parser_max_comments + 1).map(post => {
      const reply = parseCooked(this, post.cooked, origin)
      return this.createComment({
        author: this.createAuthor(post.name || post.username || "", absoluteUrl(
          String(post.avatar_template || "").replace("{size}", "96"),
          origin,
        )),
        content: reply.content.length ? reply.content : [reply.text],
        timestamp: post.created_at,
        likes: post.actions_summary?.find(item => item.id === 2)?.count,
      })
    })
    return result
  }
}

export function parseCooked(parser, cooked, baseUrl) {
  const $ = cheerio.load(cooked || "")
  const content = []
  $("p,blockquote,pre,img,a.onebox,aside.onebox").each((_, element) => {
    const node = $(element)
    if (element.name === "img") {
      const src = absoluteUrl(node.attr("src") || node.attr("data-src"), baseUrl)
      if (src) content.push(parser.createGraphic(src, node.attr("alt")))
    } else if (node.is("blockquote")) {
      content.push(parser.createQuote(cleanText(node.text())))
    } else if (node.is("a.onebox,aside.onebox")) {
      const href = absoluteUrl(node.attr("href") || node.find("a").attr("href"), baseUrl)
      if (href) content.push(parser.createLink(href, { title: cleanText(node.text()) }))
    } else {
      const text = cleanText(node.text())
      if (text) content.push(text)
    }
  })
  return { text: cleanText($.root().text()), content }
}
