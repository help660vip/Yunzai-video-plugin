import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { log } from "../core/logger.js"

const EASY_COMMENT_API = "https://easycomment.ai/api/twitter/v1/free/get-tweet-detail"

function realTweet(result = {}) {
  return result.__typename === "TweetWithVisibilityResults" ? result.tweet || {} : result
}

function tweetResults(node) {
  const item = node?.itemContent
  if (
    item?.__typename === "TimelineTweet" &&
    ["Tweet", "TweetWithVisibilityResults"].includes(item.tweet_results?.result?.__typename)
  ) {
    return [item.tweet_results]
  }
  const values = []
  if (node?.content && typeof node.content === "object") values.push(...tweetResults(node.content))
  for (const child of node?.items || []) values.push(...tweetResults(child))
  if (node?.item && typeof node.item === "object") values.push(...tweetResults(node.item))
  return values
}

function bindingValues(card) {
  return new Map(
    (card?.legacy?.binding_values || [])
      .filter(item => item?.key)
      .map(item => [item.key, item.value || {}]),
  )
}

function textValue(value) {
  if (typeof value === "string") return value || null
  return value?.content || null
}

function parseLinkCard(card) {
  if (!card?.legacy) return null
  const bindings = bindingValues(card)
  const unifiedRaw = bindings.get("unified_card")?.string_value
  if (unifiedRaw) {
    try {
      const unified = JSON.parse(unifiedRaw)
      const destination = Object.values(unified.destination_objects || {}).find(
        item => item?.type === "browser" && item?.data?.url_data?.url,
      )
      const urlData = destination?.data?.url_data
      if (urlData?.url) {
        let title = null
        let siteName = null
        let description = null
        let previewUrl = null
        for (const name of unified.components || []) {
          const component = unified.component_objects?.[name]
          const data = component?.data || {}
          if (component?.type === "details") {
            title ||= textValue(data.title)
            siteName ||= textValue(data.subtitle)
            description ||= textValue(data.description) || textValue(data.summary)
          } else if (component?.type === "media" && data.id) {
            previewUrl ||= unified.media_entities?.[data.id]?.media_url_https
          }
        }
        return {
          url: urlData.url,
          title: title || siteName || urlData.url,
          siteName: siteName || urlData.vanity,
          description,
          previewUrl,
        }
      }
    } catch {}
  }
  const string = key => bindings.get(key)?.string_value || null
  const image = (...keys) => {
    for (const key of keys) {
      const url = bindings.get(key)?.image_value?.url
      if (url) return url
    }
    return null
  }
  const url = string("card_url") || card.legacy.url
  if (!url) return null
  return {
    url,
    title: string("title") || url,
    siteName: string("vanity_url") || string("domain"),
    description: string("description"),
    previewUrl: image(
      "thumbnail_image_large",
      "thumbnail_image",
      "player_image_large",
      "player_image",
      "photo_image_full_size_large",
      "photo_image_full_size",
    ),
  }
}

function userData(tweet) {
  const user = tweet?.core?.user_results?.result || {}
  return user.__typename === "UserUnavailable" ? {} : user
}

function legacyTweetText(tweet) {
  const legacy = tweet?.legacy || {}
  const range = legacy.display_text_range
  return Array.isArray(range)
    ? String(legacy.full_text || "").slice(Number(range[0]) || 0, Number(range[1]) || undefined)
    : String(legacy.full_text || "")
}

function articleResult(tweet) {
  return tweet?.article?.article_results?.result || null
}

function articlePlainText(article) {
  const blocks = article?.content_state?.blocks
  if (!Array.isArray(blocks)) return ""
  return blocks.map(block => String(block?.text || "")).join("\n").trim()
}

function articleEntities(state) {
  const raw = state?.entityMap
  if (Array.isArray(raw)) {
    return new Map(raw.filter(Boolean).map(entity => [String(entity.key), entity.value || {}]))
  }
  if (raw && typeof raw === "object") return new Map(Object.entries(raw))
  return new Map()
}

function tweetText(tweet) {
  const note = tweet?.note_tweet?.note_tweet_results?.result?.text
  if (note) return note
  const base = legacyTweetText(tweet)
  const article = articleResult(tweet)
  const articleText = articlePlainText(article) || article?.preview_text
  return [base, articleText].filter(Boolean).join("\n\n")
}

function timestamp(value) {
  const parsed = Date.parse(value || "")
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function originalImageUrl(value) {
  try {
    const url = new URL(value)
    if (url.hostname !== "pbs.twimg.com") return value
    const match = /\.(jpe?g|png|webp)$/i.exec(url.pathname)
    if (match) {
      url.pathname = url.pathname.slice(0, -match[0].length)
      url.searchParams.set("format", match[1].toLowerCase().replace("jpeg", "jpg"))
    }
    url.searchParams.set("name", "orig")
    return url.href
  } catch {
    return value
  }
}

export class TwitterParser extends BaseParser {
  static platform = { name: "twitter", displayName: "X" }
  static handlers = [
    {
      keyword: "x.com",
      pattern: /x\.com\/[0-9-a-zA-Z_]{1,20}\/status\/([0-9]+)/,
      method: "parse",
    },
    {
      keyword: "twitter.com",
      pattern: /twitter\.com\/[0-9-a-zA-Z_]{1,20}\/status\/([0-9]+)/,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.apiHeaders = {
      host: "easycomment.ai",
      "content-type": "application/json",
    }
  }

  createTweetAuthor(tweet) {
    const user = userData(tweet)
    return this.createAuthor(
      user.core?.name || user.legacy?.name || "",
      String(user.avatar?.image_url || user.legacy?.profile_image_url_https || "").replace(
        "_normal",
        "_bigger",
      ),
      user.legacy?.description,
      this.headers,
      {
        id: user.core?.screen_name || user.legacy?.screen_name || user.rest_id,
        browser: true,
      },
    )
  }

  articleMediaContent(article, media) {
    const info = media?.media_info
    if (!info) return null
    const preview = info.preview_image?.original_img_url || info.original_img_url || null
    const variants = (info.variants || [])
      .filter(item => item?.content_type === "video/mp4" && item.url)
      .sort(
        (left, right) =>
          Number(right.bit_rate ?? right.bitrate ?? 0) -
          Number(left.bit_rate ?? left.bitrate ?? 0),
      )
    const mediaId = media.media_id ?? media.id
    const cacheKey = `x:article-media:${article.rest_id}:${mediaId}`
    if (variants.length) {
      return this.createVideo(
        variants[0].url,
        preview,
        Number(info.duration_millis || 0) / 1000,
        { browser: true, cacheKey },
      )
    }
    const imageUrl = info.original_img_url || preview
    return imageUrl ? this.createGraphic(imageUrl, null, { browser: true, cacheKey }) : null
  }

  buildArticleContent(article) {
    const state = article?.content_state
    if (!state?.blocks?.length) return article?.preview_text ? [article.preview_text] : []
    const entities = articleEntities(state)
    const mediaById = new Map(
      (article.media_entities || [])
        .filter(media => media && (media.media_id ?? media.id) !== undefined)
        .map(media => [String(media.media_id ?? media.id), media]),
    )
    const output = []
    let text = ""
    const flush = () => {
      if (text) output.push(text)
      text = ""
    }

    for (let blockIndex = 0; blockIndex < state.blocks.length; blockIndex += 1) {
      const block = state.blocks[blockIndex] || {}
      const blockText = String(block.text || "")
      if (blockIndex > 0 && text) text += "\n"
      let cursor = 0
      const ranges = [...(block.entityRanges || [])].sort(
        (left, right) => Number(left.offset || 0) - Number(right.offset || 0),
      )
      for (const range of ranges) {
        const entity = entities.get(String(range.key))
        if (entity?.type !== "MEDIA") continue
        const mediaContents = (entity.data?.mediaItems || [])
          .map(item => mediaById.get(String(item.mediaId ?? item.media_id)))
          .filter(Boolean)
          .map(media => this.articleMediaContent(article, media))
          .filter(Boolean)
        if (!mediaContents.length) continue

        // Draft.js offsets are UTF-16 code units; JavaScript String indexes use the same unit.
        const start = Math.min(Math.max(Number(range.offset || 0), cursor), blockText.length)
        const end = Math.min(
          Math.max(Number(range.offset || 0) + Number(range.length || 0), start),
          blockText.length,
        )
        text += blockText.slice(cursor, start)
        flush()
        output.push(...mediaContents)
        cursor = end
      }
      text += blockText.slice(cursor)
    }
    flush()
    return output.length ? output : article?.preview_text ? [article.preview_text] : []
  }

  buildContent(tweet) {
    const content = []
    const article = articleResult(tweet)
    const articleCover = article?.cover_media?.media_info?.original_img_url
    if (articleCover) {
      content.push(
        this.createGraphic(articleCover, null, {
          browser: true,
          cacheKey: "x:article-cover:" + tweet.rest_id,
        }),
      )
    }
    const articleContent = article ? this.buildArticleContent(article) : []
    if (articleContent.length) {
      const legacy = legacyTweetText(tweet)
      if (legacy) content.push(legacy)
      content.push(...articleContent)
    } else {
      const text = tweetText(tweet)
      if (text) content.push(text)
    }
    for (const media of tweet?.legacy?.extended_entities?.media || []) {
      if (media.type === "photo" && media.media_url_https) {
        content.push(
          this.createImage(originalImageUrl(media.media_url_https), null, this.headers, {
            browser: true,
          }),
        )
        continue
      }
      const candidates = (media.video_info?.variants || [])
        .filter(item => item.content_type === "video/mp4" && item.url)
        .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
      if (!candidates.length) continue
      const duration = Number(media.video_info?.duration_millis || 0) / 1000 || null
      if (media.type === "animated_gif") {
        content.push(this.createGif(candidates[0].url, media.media_url_https, duration))
      } else {
        content.push(this.createVideo(candidates[0].url, media.media_url_https, duration))
      }
    }
    const card = parseLinkCard(tweet?.card)
    if (card) {
      content.push(
        this.createLink(card.url, {
          title: card.title,
          siteName: card.siteName,
          description: card.description,
          previewUrl: card.previewUrl,
          cacheKey: "x:link:" + card.url,
          browser: true,
        }),
      )
    }
    return content
  }

  buildComment(tweet) {
    const legacy = tweet?.legacy || {}
    return this.createComment({
      author: this.createTweetAuthor(tweet),
      content: this.buildContent(tweet),
      timestamp: timestamp(legacy.created_at),
      stats: this.createStats({
        likes: legacy.favorite_count,
        comments: legacy.reply_count,
      }),
    })
  }

  buildComments(rootId, tweetMap) {
    const comments = new Map()
    const parents = new Map()
    for (const [id, raw] of tweetMap) {
      if (id === rootId) continue
      const tweet = realTweet(raw?.result)
      const parentId = tweet?.legacy?.in_reply_to_status_id_str
      if (!parentId) continue
      comments.set(id, this.buildComment(tweet))
      parents.set(id, String(parentId))
    }
    const roots = []
    for (const [id, comment] of comments) {
      const parentId = parents.get(id)
      if (comments.has(parentId)) comments.get(parentId).replies.push(comment)
      else if (parentId === rootId) roots.push(comment)
    }
    return roots.slice(0, config.parser_max_comments)
  }

  collectTweet(tweet, nested = false) {
    const legacy = tweet?.legacy || {}
    const user = userData(tweet)
    const screenName = user.core?.screen_name || user.legacy?.screen_name || "i"
    const sensitive = Boolean(legacy.possibly_sensitive)
    const article = articleResult(tweet)
    const result = this.result({
      contentId: tweet?.rest_id,
      author: this.createTweetAuthor(tweet),
      title: article?.title || null,
      text: tweetText(tweet),
      content: this.buildContent(tweet),
      timestamp: timestamp(legacy.created_at),
      url: `https://x.com/${screenName}/status/${tweet?.rest_id}`,
      stats: this.createStats({
        views: Number(tweet?.views?.count || 0),
        likes: legacy.favorite_count,
        comments: legacy.reply_count,
        collects: legacy.bookmark_count,
        shares: Number(legacy.quote_count || 0) + Number(legacy.retweet_count || 0),
      }),
      safety: {
        sensitive,
        rating: sensitive ? "sensitive" : "unknown",
      },
      extra: { possibly_sensitive: sensitive },
    })
    const repostRaw = tweet?.quoted_status_result || tweet?.retweeted_status_result
    if (!nested && repostRaw?.result) {
      result.repost = this.collectTweet(realTweet(repostRaw.result), true)
    }
    return result
  }

  collectEasyComment(payload, tweetId) {
    const instructions =
      payload?.data?.data?.threaded_conversation_with_injections_v2?.instructions || []
    const entries = instructions.find(item => item.type === "TimelineAddEntries")?.entries
    if (!entries) throw new ParseError("TimelineAddEntries not found")
    const tweetMap = new Map()
    let root = null
    for (const entry of entries) {
      for (const raw of tweetResults(entry)) {
        const tweet = realTweet(raw?.result)
        const id = tweet?.rest_id
        if (!id) continue
        tweetMap.set(String(id), raw)
        if (String(id) === String(tweetId)) root = raw
      }
    }
    if (!root) throw new ParseError(`Tweet ${tweetId} not found`)
    const rootTweet = realTweet(root.result)
    if (!rootTweet.quoted_status_result) {
      const parentId =
        rootTweet.legacy?.in_reply_to_status_id_str || rootTweet.legacy?.conversation_id_str
      if (parentId && String(parentId) !== String(tweetId) && tweetMap.has(String(parentId))) {
        rootTweet.quoted_status_result = tweetMap.get(String(parentId))
      }
    }
    const result = this.collectTweet(rootTweet)
    result.comments = this.buildComments(String(tweetId), tweetMap)
    return result
  }

  async parse(match) {
    const tweetId = match[1]
    try {
      const payload = await http.json(EASY_COMMENT_API, {
        method: "POST",
        headers: this.apiHeaders,
        body: { pid: tweetId },
        browser: true,
      })
      if (payload?.code !== 100000) throw new ParseError("X 接口返回错误")
      return this.collectEasyComment(payload, tweetId)
    } catch (error) {
      log.warn(`[parser] X 富内容接口失败，回退 VxTwitter: ${error.message}`)
      const url = `https://x.com/i/status/${tweetId}`
      const data = await http.json(url.replace("x.com", "api.vxtwitter.com"), {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36",
        },
      })
      return this.collectVx(data, tweetId)
    }
  }

  collectVx(data, fallbackId = null) {
    const title = typeof data.article === "object" ? data.article?.title : data.article
    const content = []
    if (data.text) content.push(data.text)
    const result = this.result({
      contentId: data.tweetID || data.id || fallbackId,
      author: this.createAuthor(data.user_name, data.user_profile_image_url),
      title,
      text: data.text,
      content,
      timestamp: data.date_epoch,
      url: data.tweetURL || data.url,
      stats: this.createStats({
        likes: data.likes,
        comments: data.replies,
        shares: data.retweets,
        views: data.views,
      }),
      safety: {
        sensitive: Boolean(data.possibly_sensitive || data.sensitive),
        rating: data.possibly_sensitive || data.sensitive ? "sensitive" : "unknown",
      },
      extra: {
        possibly_sensitive: Boolean(data.possibly_sensitive || data.sensitive),
        tags: data.tags || data.hashtags || [],
      },
    })
    for (const media of data.media_extended || []) {
      let item = null
      if (media.type === "video") {
        item = this.createVideo(
          media.url,
          media.thumbnail_url,
          media.duration_millis ? media.duration_millis / 1000 : null,
        )
      } else if (media.type === "gif") {
        item = this.createGif(
          media.url,
          media.thumbnail_url,
          media.duration_millis ? media.duration_millis / 1000 : null,
        )
      } else if (media.type === "image") {
        item = this.createImage(
          originalImageUrl(media.url),
          null,
          this.headers,
          { browser: true },
        )
      }
      if (item) content.push(item)
    }
    if (data.qrt) result.repost = this.collectVx(data.qrt)
    return result
  }

  collect(data, fallbackId = null) {
    return this.collectVx(data, fallbackId)
  }
}
