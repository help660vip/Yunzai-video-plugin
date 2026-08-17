import { config } from "../core/config.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { log } from "../core/logger.js"
import { MIYOUSHE_STICKERS } from "./miyoushe-stickers.js"
import { OpenGraphParser } from "./shared.js"

const API_ROOT = "https://bbs-api.miyoushe.com/post/wapi/"
const GAME_NAMES = Object.freeze({
  1: "bh3",
  2: "ys",
  3: "bh2",
  4: "wd",
  5: "dby",
  6: "sr",
  8: "zzz",
  9: "hna",
  10: "planet",
})

function stickerText(parser, value) {
  const output = []
  const text = String(value || "")
  let cursor = 0
  for (const match of text.matchAll(/_\((.+?)\)/g)) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index))
    const url = MIYOUSHE_STICKERS[match[1]]
    if (url) {
      output.push(
        parser.createSticker(url, "small", match[1], {
          cacheKey: "sticker:miyoushe:" + match[1],
        }),
      )
    } else {
      output.push(match[0])
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) output.push(text.slice(cursor))
  return output.filter(Boolean)
}

function structuredItems(value) {
  if (!String(value || "").trim()) return []
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return [String(value)]
  }
}

export class MiyousheApiParser extends OpenGraphParser {
  static platform = { name: "miyoushe", displayName: "米游社" }
  static handlers = [
    {
      keyword: "miyoushe.com",
      pattern: /(?:www\.|m\.)?miyoushe\.com\/[^\s<]*?article\/(\d+)[^\s<]*/i,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = { ...this.headers, referer: "https://www.miyoushe.com/" }
  }

  buildStructured(value) {
    const content = []
    for (const wrapper of structuredItems(value)) {
      const insert = wrapper?.insert ?? wrapper
      if (typeof insert === "string") {
        content.push(...stickerText(this, insert))
        continue
      }
      if (!insert || typeof insert !== "object") continue
      if (insert.vod) {
        const video = insert.vod
        const resolution = video.resolutions?.[0]
        if (resolution?.url) {
          content.push(
            this.createVideo(resolution.url, video.cover, video.duration, {
              cacheKey: "miyoushe:" + video.id,
            }),
          )
        }
      } else if (insert.link_card) {
        const card = insert.link_card
        if (card.origin_url) {
          content.push(
            this.createLink(card.origin_url, {
              title: card.title,
              siteName: card.origin_user_nickname || "米游社",
              iconUrl: card.origin_user_avatar,
              previewUrl: card.cover,
              cacheKey: "miyoushe:link:" + (card.card_id || card.origin_url),
            }),
          )
        }
      } else if (insert.image) {
        content.push(this.createGraphic(insert.image))
      } else if (insert.custom_emoticon?.url) {
        content.push(
          this.createSticker(
            insert.custom_emoticon.url,
            "small",
            insert.backup_text || null,
            { cacheKey: "miyoushe:emoticon:" + insert.custom_emoticon.id },
          ),
        )
      } else if (insert.video) {
        let bvid = null
        try {
          bvid = new URL(insert.video).searchParams.get("bvid")
        } catch {
          bvid = /[?&]bvid=([^&#]+)/.exec(insert.video)?.[1]
        }
        if (bvid) {
          content.push(
            this.createLink(`https://www.bilibili.com/video/${bvid}`, {
              title: bvid,
              siteName: "哔哩哔哩",
            }),
          )
        }
      } else if (insert.backup_text) {
        content.push(insert.backup_text)
      }
    }
    return content
  }

  createMiyousheAuthor(user = {}) {
    return this.createAuthor(
      user.nickname || "",
      user.avatar_url,
      user.introduce,
      this.headers,
      { id: user.uid, location: user.ip_region },
    )
  }

  buildComment(node) {
    const reply = node.reply || {}
    const comment = this.createComment({
      author: this.createMiyousheAuthor(node.user),
      content: this.buildStructured(reply.struct_content),
      timestamp: reply.updated_at || reply.created_at,
      stats: this.createStats({
        likes: node.stat?.like_num,
        comments: node.stat?.sub_num,
      }),
    })
    comment.replies.push(...(node.sub_replies || []).map(item => this.buildComment(item)))
    return comment
  }

  collectPost(payload, commentsPayload, postId) {
    if (Number(payload?.retcode) !== 0 || !payload?.data?.post) {
      throw new ParseError(payload?.message || "米游社帖子接口返回错误")
    }
    const wrapper = payload.data.post
    const post = wrapper.post || {}
    const content = this.buildStructured(post.structured_content)
    if (Number(post.view_type) === 2) {
      content.push(...this.createImages(post.images || []))
    }
    const stat = wrapper.stat || {}
    const game = GAME_NAMES[post.game_id] || "ys"
    const comments =
      Number(commentsPayload?.retcode) === 0
        ? (commentsPayload?.data?.list || [])
            .slice(0, config.parser_max_comments)
            .map(item => this.buildComment(item))
        : []
    return this.result({
      contentId: post.post_id || postId,
      author: this.createMiyousheAuthor(wrapper.user),
      title: post.subject,
      text: content.filter(item => typeof item === "string").join("\n"),
      content,
      timestamp: post.created_at,
      url: `https://m.miyoushe.com/${game}/#/article/${post.post_id || postId}`,
      stats: this.createStats({
        views: stat.view_num,
        likes: stat.like_num,
        collects: stat.bookmark_num,
        shares: Number(stat.share_num || 0) + Number(stat.forward_num || 0),
        comments: stat.reply_num,
      }),
      comments,
    })
  }

  async parse(match) {
    const postId = match[1]
    try {
      const payload = await http.json(API_ROOT + "getPostFull", {
        headers: this.headers,
        params: { post_id: postId },
      })
      let commentsPayload = null
      try {
        commentsPayload = await http.json(API_ROOT + "getPostReplies", {
          headers: this.headers,
          params: {
            post_id: postId,
            is_hot: true,
            size: config.parser_max_comments,
          },
        })
      } catch (error) {
        log.warn(`[parser] 米游社评论获取失败: ${error.message}`)
      }
      return this.collectPost(payload, commentsPayload, postId)
    } catch (error) {
      if (error instanceof ParseError) throw error
      return super.parse(match)
    }
  }
}
