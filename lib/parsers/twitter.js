import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { log } from "../core/logger.js"
import crypto from "node:crypto"

const EASY_COMMENT_API = "https://easycomment.ai/api/twitter/v1/free/get-tweet-detail"
const VISIBILITY_WARNINGS = Symbol("visibilityWarnings")
const COMMENT_TWEET = Symbol("commentTweet")
// Public web-client bearer, not an account access token.
const WEB_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
const FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true, premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false, responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true, responsive_web_jetfuel_frame: true, rweb_sports_post_context_enabled: true,
  responsive_web_grok_share_attachment_enabled: true, responsive_web_grok_annotations_enabled: true, articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true, rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true, content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true, responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false, rweb_cashtags_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true, responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false, verified_phone_label_enabled: false, responsive_web_nested_quote_preview_enabled: false,
  responsive_web_grok_image_annotation_enabled: true, responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
}

function accountCookies() {
  return Object.fromEntries(String(config.parser_x_ck || "").split(";").map(item => {
    const position = item.indexOf("=")
    return position > 0 ? [item.slice(0, position).trim(), item.slice(position + 1).trim()] : []
  }).filter(item => item.length === 2))
}

function warningTexts(value, depth = 0) {
  if (depth > 16 || value == null) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(item => warningTexts(item, depth + 1))
  if (typeof value === "object") return Object.values(value).flatMap(item => warningTexts(item, depth + 1))
  return []
}

function realTweet(result = {}) {
  if (result.__typename !== "TweetWithVisibilityResults") return result
  const tweet = result.tweet || {}
  return {
    ...tweet,
    [VISIBILITY_WARNINGS]: [
      ...(tweet[VISIBILITY_WARNINGS] || []),
      ...warningTexts(result.tweetInterstitial),
      ...warningTexts(result.tombstone),
      ...warningTexts(result.limitedActionResults),
    ],
  }
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

function referenceSafety(tweet, seen = new Set(), depth = 0) {
  if (!tweet || seen.has(tweet)) return { sensitive: false, adult: false, text: [] }
  if (depth > 32) throw new ParseError("X 引用内容层级过深")
  seen.add(tweet)
  const warnings = (tweet.legacy?.extended_entities?.media || []).some(media => media.sensitive_media_warning)
  const visibility = [...(tweet[VISIBILITY_WARNINGS] || []), ...warningTexts(tweet.tweetInterstitial)]
  const result = {
    sensitive: Boolean(tweet.legacy?.possibly_sensitive || tweet.possibly_sensitive || warnings ||
      visibility.some(text => /\bsensitive\b|敏感内容|敏感媒体/i.test(text))),
    adult: visibility.some(text => /\badult\b|\bnsfw\b|\br[\s_-]?18\b|\b18\s*\+|porn|成人|色情/i.test(text)),
    text: [tweetText(tweet), articleResult(tweet)?.title,
      userData(tweet).profile_bio?.description ?? userData(tweet).legacy?.description, ...visibility],
  }
  for (const entry of [tweet.quoted_status_result, tweet.retweeted_status_result, tweet.legacy?.retweeted_status_result]) {
    if (!entry?.result) continue
    const nested = referenceSafety(realTweet(entry.result), seen, depth + 1)
    result.sensitive ||= nested.sensitive
    result.adult ||= nested.adult
    result.text.push(...nested.text)
  }
  return result
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
    this.guestToken = null
    this.guestTokenCreatedAt = 0
    this.guestTokenTask = null
    this.apiHeaders = {
      host: "easycomment.ai",
      "content-type": "application/json",
    }
  }

  async ensureGuestToken() {
    if (this.guestToken && Date.now() - this.guestTokenCreatedAt < 7200000) return this.guestToken
    if (!this.guestTokenTask) {
      this.guestTokenTask = (async () => {
        const data = await http.json("https://api.x.com/1.1/guest/activate.json", {
          method: "POST", headers: { ...this.headers, authorization: WEB_BEARER },
        })
        if (typeof data?.guest_token !== "string" || !data.guest_token) {
          throw new ParseError("X 未返回有效的访客令牌")
        }
        this.guestToken = data.guest_token
        this.guestTokenCreatedAt = Date.now()
        return this.guestToken
      })().finally(() => { this.guestTokenTask = null })
    }
    return this.guestTokenTask
  }

  async authHeaders() {
    const cookies = accountCookies()
    const csrf = cookies.ct0 || crypto.randomBytes(16).toString("hex")
    const headers = {
      ...this.headers, authorization: WEB_BEARER, "x-twitter-active-user": "yes",
      "x-twitter-client-language": "zh-cn", "x-csrf-token": csrf,
    }
    if (cookies.auth_token) {
      headers.cookie = "auth_token=" + cookies.auth_token + "; ct0=" + csrf + ";"
      headers["x-twitter-auth-type"] = "OAuth2Session"
    } else headers["x-guest-token"] = await this.ensureGuestToken()
    return headers
  }

  createTweetAuthor(tweet) {
    const user = userData(tweet)
    return this.createAuthor(
      user.core?.name || user.legacy?.name || "",
      String(user.avatar?.image_url || user.legacy?.profile_image_url_https || "").replace(
        "_normal",
        "_bigger",
      ),
      user.profile_bio?.description ?? user.legacy?.description,
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
            layout: "x",
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
    const comment = this.createComment({
      author: this.createTweetAuthor(tweet),
      content: this.buildContent(tweet),
      timestamp: timestamp(legacy.created_at),
      stats: this.createStats({
        likes: legacy.favorite_count,
        comments: legacy.reply_count,
      }),
    })
    // Keep source metadata private; only selected comment trees contribute to safety.
    Object.defineProperty(comment, COMMENT_TWEET, { value: tweet })
    return comment
  }

  mergeCommentSafety(result) {
    const seen = new Set()
    const visit = comment => {
      if (!comment || seen.has(comment)) return
      seen.add(comment)
      if (comment[COMMENT_TWEET]) {
        const safety = referenceSafety(comment[COMMENT_TWEET])
        result.safety.sensitive ||= safety.sensitive
        if (safety.adult) result.safety.rating = "adult"
        result.extra.tags ||= []
        result.extra.tags.push(...safety.text.filter(Boolean))
      }
      for (const reply of comment.replies || []) visit(reply)
    }
    for (const comment of result.comments || []) visit(comment)
  }

  buildComments(rootId, tweetMap) {
    if (!config.parser_max_comments) return []
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

  collectTweet(tweet, depth = 0, seen = new Set()) {
    seen.add(tweet)
    const legacy = tweet?.legacy || {}
    const user = userData(tweet)
    const screenName = user.core?.screen_name || user.legacy?.screen_name || "i"
    const reference = referenceSafety(tweet)
    const sensitive = reference.sensitive
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
        views: tweet?.views?.count == null ? null : Number(tweet.views.count),
        likes: legacy.favorite_count,
        comments: legacy.reply_count,
        collects: legacy.bookmark_count,
        shares: Number(legacy.quote_count || 0) + Number(legacy.retweet_count || 0),
      }),
      safety: {
        sensitive,
        rating: reference.adult ? "adult" : sensitive ? "sensitive" : "unknown",
      },
      extra: { possibly_sensitive: sensitive, tags: reference.text.filter(Boolean) },
    })
    const translated = tweet.grok_translated_post_with_availability
    if (legacy.lang && !legacy.lang.startsWith("zh") && translated?.is_available && translated?.data?.translation) {
      result.content.push(this.createQuote(translated.data.translation, { title: "由 Grok 翻译自 " + legacy.lang }))
    }
    const repostRaw = tweet?.quoted_status_result || tweet?.retweeted_status_result || legacy.retweeted_status_result
    const repost = realTweet(repostRaw?.result)
    if (repostRaw?.result && !seen.has(repost)) {
      if (depth >= 32) throw new ParseError("X 引用内容层级过深")
      result.repost = this.collectTweet(repost, Number(depth) + 1, seen)
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
    this.mergeCommentSafety(result)
    return result
  }

  async parse(match) {
    const tweetId = match[1]
    let tweet
    try {
      const payload = await http.json("https://x.com/i/api/graphql/Xl0tsHf4AzflMRjbw9e70A/TweetResultByRestId", {
        headers: await this.authHeaders(),
        params: {
          variables: JSON.stringify({
            tweetId, includePromotedContent: true, withBirdwatchNotes: true, withVoice: true,
            withCommunity: true, withV2Timeline: true, withQuickPromoteEligibilityTweetFields: true,
          }),
          features: JSON.stringify(FEATURES),
          fieldToggles: JSON.stringify({
            withArticleRichContentState: true, withArticlePlainText: false,
            withArticleSummaryText: true, withArticleVoiceOver: true,
          }),
        },
      })
      tweet = realTweet(payload?.data?.tweetResult?.result)
      if (!tweet?.rest_id || !tweet.legacy) {
        const restriction = referenceSafety(tweet)
        if (restriction.adult || restriction.sensitive) {
          return this.result({
            contentId: tweetId,
            safety: { sensitive: restriction.sensitive, rating: restriction.adult ? "adult" : "sensitive" },
            extra: { tags: restriction.text.filter(Boolean) },
          })
        }
        throw new ParseError("X 内容不可访问或已删除")
      }
    } catch {
      // Do not include authenticated response bodies or request headers in logs.
      log.debug("[parser] X 主接口暂不可用，尝试备用接口")
      return this.parseFallback(tweetId)
    }
    // Parsing or safety metadata failures must never discard a known primary result.
    const result = this.collectTweet(tweet)
    await this.translateResult(tweet, result)
    if (config.parser_max_comments > 0) {
      try {
        const comments = await http.json(EASY_COMMENT_API, {
          method: "POST", headers: this.apiHeaders, body: { pid: tweetId }, browser: true,
        })
        if (comments?.code === 100000) {
          const detailed = this.collectEasyComment(comments, tweetId)
          result.comments = detailed.comments
          // Extra metadata from a secondary response may strengthen but never weaken safety.
          result.safety.sensitive ||= detailed.safety.sensitive
          if (detailed.safety.rating === "adult") result.safety.rating = "adult"
          result.extra.tags.push(...(detailed.extra.tags || []))
          if (!result.repost && detailed.repost) result.repost = detailed.repost
        }
      } catch { log.debug("[parser] X 评论暂不可用") }
    }
    return result
  }

  async translateResult(tweet, result, depth = 0) {
    const lang = tweet.legacy?.lang || ""
    if (lang && !lang.startsWith("zh") && tweet.is_translatable &&
        !tweet.grok_translated_post_with_availability?.is_available && accountCookies().auth_token) {
      try {
        const translated = await http.json("https://api.x.com/2/grok/translation.json", {
          method: "POST", headers: await this.authHeaders(),
          body: { content_type: "POST", id: tweet.rest_id, dst_lang: "zh" },
        })
        if (typeof translated?.result?.text === "string" && translated.result.text) {
          result.content.push(this.createQuote(translated.result.text, { title: "由 Grok 翻译自 " + lang }))
        }
      } catch { log.debug("[parser] X 翻译暂不可用") }
    }
    const nested = tweet.quoted_status_result || tweet.retweeted_status_result || tweet.legacy?.retweeted_status_result
    if (depth < 32 && nested?.result && result.repost) {
      await this.translateResult(realTweet(nested.result), result.repost, depth + 1)
    }
  }

  async parseFallback(tweetId) {
    let payload
    try {
      payload = await http.json(EASY_COMMENT_API, {
        method: "POST",
        headers: this.apiHeaders,
        body: { pid: tweetId },
        browser: true,
      })
      if (payload?.code !== 100000) throw new ParseError("X 接口返回错误")
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
    return this.collectEasyComment(payload, tweetId)
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
          { browser: true, layout: "x" },
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
