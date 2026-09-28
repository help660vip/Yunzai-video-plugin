import crypto from "node:crypto"
import * as cheerio from "cheerio"
import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { ParseError } from "../core/errors.js"
import { OpenGraphParser, htmlToText, richHtml, textStickers } from "./shared.js"

function sourceUrl(match) {
  return /^https?:\/\//i.test(match[0]) ? match[0] : "https://" + match[0]
}

function query(match, route) {
  return route?.params || Object.fromEntries(new URL(sourceUrl(match)).searchParams)
}

async function optionalComments(task) {
  if (!config.parser_max_comments) return []
  try { return (await task()).slice(0, config.parser_max_comments) } catch { return [] }
}

function commentAuthor(parser, user = {}, location) {
  return parser.createAuthor(user.nickname || user.username || user.name || "", user.avatar, null, parser.headers, {
    id: user.user_id || user.id, location: location || user.ip_location,
  })
}

export class BuffApiParser extends OpenGraphParser {
  async api(path, params) {
    const response = await http.json("https://buff.163.com/api/" + path, { params, headers: this.headers })
    if (response.code !== "OK" || !response.data) throw new ParseError("BUFF 内容暂不可访问")
    return response.data
  }

  comment(row, depth = 0) {
    let text = row.message || ""
    const images = (row.pictures || []).map(pic => {
      if (pic.is_emoji) {
        text = text.replace("[" + pic.name + "]", "")
        return this.createSticker(pic.icon_url, "medium", pic.name)
      }
      return this.createImage(pic.icon_url)
    })
    return this.createComment({
      author: commentAuthor(this, row.author), content: [text, ...images].filter(Boolean),
      timestamp: row.created_at, stats: this.createStats({ likes: row.ups_num, comments: row.replies?.length }),
      replies: depth < 10 ? (row.replies || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }

  async parse(match, route) {
    const params = query(match, route)
    const kind = String(params.comment_type)
    const id = params.article_id || params.preview_id || params.social_topic_post_id
    let post, user, content
    if (kind === "216") {
      const value = await this.api("market/preview/share_detail", { preview_id: id, game: params.game })
      post = value.preview
      user = value.user_infos?.[post.user_id]
      content = [post.description, this.createGraphic(post.icon_url)].filter(Boolean)
    } else if (kind === "239") {
      const value = await this.api("topic/posts/detail", { social_topic_post_id: id })
      post = value.items?.[0]
      if (!post) throw new ParseError("BUFF 帖子不存在")
      user = value.user_infos?.[post.author_id]
      content = [post.content, ...(post.pictures || []).map(pic => this.createImage(pic.image_url))].filter(Boolean)
    } else {
      post = await this.api("news/share/detail", { article_id: id })
      user = { nickname: post.author, avatar: post.avatar, user_id: post.user_id, ip_location: post.ip_location }
      content = richHtml(this, post.body, "https://buff.163.com/")
      for (const video of post.video || []) {
        if (video.video_url) content.push(this.createVideo(video.video_url, video.icon_url, Number(video.duration)))
      }
    }
    const comments = await optionalComments(async () => {
      const data = await this.api("comment/share/detail", { comment_type: kind, type_id: id })
      return (data.items || []).map(row => this.comment(row))
    })
    return this.result({
      contentId: kind + ":" + id, title: post.share_data?.title, content,
      timestamp: post.publish_time, url: post.share_data?.url || sourceUrl(match),
      author: commentAuthor(this, user),
      stats: this.createStats({ views: post.views, likes: post.ups_num, comments: post.replies }), comments,
    })
  }
}

function nextData(html) {
  const $ = cheerio.load(html)
  try { return JSON.parse($("#__NEXT_DATA__").text()).props.pageProps } catch {
    throw new ParseError("页面未返回结构化数据")
  }
}

export class CoolapkApiParser extends OpenGraphParser {
  content(row) {
    return [...textStickers(this, htmlToText(row.message, "https://coolapk.com/"), "coolapk"),
      ...this.createImages(row.picArr || [])]
  }
  comment(row, depth = 0) {
    return this.createComment({
      author: this.createAuthor(row.username, row.userAvatar, null, this.headers, { id: row.uid }),
      content: this.content(row), timestamp: row.dateline,
      stats: this.createStats({ likes: row.likenum, comments: row.replynum }),
      replies: depth < 10 ? (row.replyRows || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }
  async parse(match) {
    const id = /feed\/(\d+)/.exec(match[0])?.[1]
    const data = nextData(await http.text("https://www.coolapk1s.com/feed/" + id, { headers: this.headers }))
    const post = data.feed
    if (!post) throw new ParseError("酷安帖子不存在")
    const comments = await optionalComments(async () => {
      const value = nextData(await http.text("https://www.coolapk1s.com/reply/" + id, {
        headers: { ...this.headers, referer: "https://www.coolapk1s.com/feed/" + id },
      }))
      return (value.replies || []).map(row => this.comment(row))
    })
    return this.result({
      contentId: id, author: this.createAuthor(post.username, post.userAvatar, null, this.headers, { id: post.uid }),
      content: this.content(post), timestamp: post.dateline,
      url: "https://www.coolapk.com/feed/" + id, aiSummary: data.aiSummary, comments,
    })
  }
}

export class DuitangApiParser extends OpenGraphParser {
  async api(path, params) {
    const value = await http.json("https://www.duitang.com/napi/" + path, { params, headers: this.headers })
    if (Number(value.status) !== 1 || !value.data) throw new ParseError("堆糖内容暂不可访问")
    return value.data
  }
  comment(row, depth = 0) {
    return this.createComment({
      author: commentAuthor(this, row.sender, row.ipaddr),
      content: [row.content, ...this.createImages((row.photos || []).map(photo => photo.path))].filter(Boolean),
      timestamp: Number(row.create_time ?? row.add_datetime_ts ?? 0) / 1000,
      stats: this.createStats({ likes: row.like_count, comments: row.reply_count }),
      replies: depth < 10 ? (row.replies || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }
  async parse(match, route) {
    const id = query(match, route).id
    const atlas = /\/atlas/.test(match[0])
    const value = await this.api(atlas ? "vienna/atlas/detail/" : "blog/with_instance_tag/detail/", atlas
      ? { atlas_id: id } : { blog_id: id, include_fields: "tags,related_albums,related_albums.covers,root_album,share_links_2,extra_links,icon_description,root_id" })
    const content = [atlas ? value.desc : value.msg, ...this.createImages(atlas
      ? (value.blogs || []).map(blog => blog.photo?.path).filter(Boolean) : [value.photo?.path].filter(Boolean))].filter(Boolean)
    const comments = await optionalComments(async () => {
      const response = await this.api("vienna/comment/list/", {
        subject_id: value.id || id, subject_type: atlas ? 23 : 0, start: 0, more: 1, limit: config.parser_max_comments,
      })
      return (response.object_list || []).map(row => this.comment(row))
    })
    return this.result({
      contentId: (atlas ? "atlas:" : "blog:") + id, content, comments,
      author: commentAuthor(this, value.sender), timestamp: atlas ? Number(value.created_at) / 1000 : value.add_datetime_ts,
      url: "https://www.duitang.com/" + (atlas ? "atlas" : "blog") + "?id=" + id,
      stats: this.createStats({ views: value.visit_count, likes: value.like_count, collects: value.favorite_count, comments: value.comment_count ?? value.reply_count }),
    })
  }
}

export class DsApiParser extends OpenGraphParser {
  async api(path, params) {
    const value = await http.json("https://inf.ds.163.com/v1/web/" + path, { params, headers: this.headers })
    if (Number(value.code) !== 200 || !value.result) throw new ParseError("网易大神内容暂不可访问")
    return value.result
  }
  author(row = {}, user = {}) {
    return this.createAuthor(user.nick || row.uid || "", user.icon, user.intro, this.headers, {
      id: user.uid || row.uid, location: row.displayIpInfo?.ipLocationName,
    })
  }
  buildComments(payloads) {
    const users = new Map(payloads.flatMap(data => data.userInfos || []).map(info => [info.user.uid, info.user]))
    const roots = payloads.flatMap(data => data.feedComments || [])
    const replies = payloads.flatMap(data => data.featuredReplies || [])
    const nodes = new Map()
    for (const row of [...roots, ...replies]) {
      if (nodes.has(row.id)) continue
      const text = row.commentRich?.name ? String(row.content || "").replace("[" + row.commentRich.name + "]", "") : row.content
      nodes.set(row.id, this.createComment({
        author: this.author(row, users.get(row.uid)),
        content: [text, ...(row.commentRich?.url ? [this.createImage(row.commentRich.url)] : [])].filter(Boolean),
        timestamp: Number(row.createTime) / 1000,
        stats: this.createStats({ likes: row.record?.likeCount, comments: row.record?.commentCount }),
      }))
    }
    const attached = new Set()
    for (const row of replies) {
      const root = nodes.get(String(row.parent || "").split(".").at(-1))
      const node = nodes.get(row.id)
      if (root && node && root !== node && !attached.has(row.id)) {
        node.parentAuthor = nodes.get(row.replyId)?.author || (row.replyUid ? this.author({ uid: row.replyUid }, users.get(row.replyUid)) : null)
        root.replies.push(node)
        attached.add(row.id)
      }
    }
    return [...new Map(roots.map(row => [row.id, nodes.get(row.id)])).values()].slice(0, config.parser_max_comments)
  }
  async parse(match) {
    const id = /(?:feed|article)\/([A-Za-z0-9]+)/.exec(match[0])?.[1]
    const data = await this.api("feed/basic/facade", { feedId: id })
    const feed = data.feed
    if (!feed) throw new ParseError("网易大神帖子不存在")
    let raw
    try { raw = typeof feed.content === "string" ? JSON.parse(feed.content) : feed.content } catch { throw new ParseError("网易大神正文格式不正确") }
    const body = raw?.body || {}
    const content = body.longText ? richHtml(this, body.longText, "https://ds.163.com/") : [body.text].filter(Boolean)
    if (!body.longText) for (const media of body.media || []) {
      if (!media.url) continue
      if (String(media.mimeType).startsWith("video")) content.push(this.createVideo(media.url, media.cover, Number(media.duration) / 1000))
      else if (String(media.mimeType).startsWith("image")) content.push(this.createImage(media.url))
    }
    const payloads = []
    if (config.parser_max_comments > 0) {
      const sid = feed.uid + "." + id
      for (const [path, params] of [
        ["comment/getCommentsByHandpicked", { sid, tier: 1 }],
        ["comment/page", { sid, tier: 1, sortDirection: "DESC", count: config.parser_max_comments }],
      ]) try { payloads.push(await this.api(path, params)) } catch {}
    }
    const user = (data.userInfos || []).find(info => String(info.user?.uid) === String(feed.uid))?.user
    return this.result({
      contentId: feed.id || id, title: body.title, author: this.author(feed, user), content,
      timestamp: Number(feed.createTime) / 1000, url: "https://ds.163.com/feed/" + id,
      stats: this.createStats({ likes: feed.record?.likeCount, comments: feed.record?.commentCount, collects: feed.record?.favCount, shares: feed.record?.shareCount }),
      comments: this.buildComments(payloads),
    })
  }
}

export class FiveEPlayApiParser extends OpenGraphParser {
  comment(row, depth = 0) {
    const user = row.user_data || {}
    return this.createComment({
      author: this.createAuthor(user.username, user.avatar_url, null, this.headers, { id: user.domain }),
      content: [String(row.content || "").split("<***>")[0].split("<end>")[0], ...this.createImages(row.images || [])].filter(Boolean),
      timestamp: Number(row.dateline), stats: this.createStats({ likes: row.likes }),
      replies: depth < 10 ? (row.children || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }
  async parse(match) {
    const id = /(?:forum\/(?:forum\/|share\/)?)(\d+)/.exec(match[0])?.[1]
    const data = await http.json("https://app.5eplay.com/api/csgo/forum/topic/" + id, { headers: this.headers })
    const post = data.data?.content
    if (!post || data.success === false) throw new ParseError("5EPlay 帖子不存在")
    const content = [htmlToText(String(post.intro_text || "").split("<img")[0], "https://csgo.5eplay.com/"),
      ...this.createImages(post.images || [])].filter(Boolean)
    if (post.video_data?.video_url) content.push(this.createVideo(post.video_data.video_url, post.video_data.video_cover))
    return this.result({
      contentId: post.tid || id, title: post.title, content,
      author: this.createAuthor(post.username, post.avatar_url, null, this.headers, { id: post.domain }),
      timestamp: Number(post.dateline), url: post.share_data?.share_url || "https://csgo.5eplay.com/forum/" + id,
      stats: this.createStats({ likes: post.topic_likes_count, shares: post.forward, comments: data.data?.comments?.total, collects: post.topic_favorites, views: post.hits }),
      comments: (data.data?.comments?.list || []).slice(0, config.parser_max_comments).map(row => this.comment(row)),
    })
  }
}

export class HupuApiParser extends OpenGraphParser {
  async api(path, params = {}) {
    const queryText = Object.keys(params).sort().map(key => key + "=" + params[key]).join("&")
    // Public request-signing salt defined by the mobile API protocol.
    const sign = crypto.createHash("md5").update(queryText + "HUPU_SALT_AKJfoiwer394Jeiow4u309").digest("hex")
    return http.json("https://bbs.mobileapi.hupu.com/1/7.5.51/threads/" + path, {
      params: { ...params, sign }, headers: this.headers,
    })
  }
  buildComments(rows) {
    const nodes = new Map()
    const roots = []
    for (const row of rows) {
      const node = this.createComment({
        author: this.createAuthor(row.userName, row.userImg, null, this.headers, { id: row.puid, location: row.location }),
        content: richHtml(this, row.content, "https://bbs.hupu.com/"),
        timestamp: Number(row.create_time),
        stats: this.createStats({ likes: row.light_count, comments: row.check_reply_info?.num }),
      })
      const parent = nodes.get(row.quote?.[0]?.pid)
      if (parent) parent.replies.push(node)
      else roots.push(node)
      nodes.set(row.pid, node)
    }
    return roots
  }
  async parse(match) {
    const id = /(?:hupu\.com\/(?:bbs-share\/|bbs\/)?)(\d+)/.exec(match[0])?.[1]
    const data = await this.api(id)
    const post = data.offline_data?.data
    if (!post) throw new ParseError("虎扑帖子不存在")
    const content = richHtml(this, post.content, "https://bbs.hupu.com/")
    if (data.video_info?.src) content.push(this.createVideo(data.video_info.src, data.video_info.img, Number(data.video_info.duration), { cacheKey: "hupu:" + id }))
    const comments = await optionalComments(async () => {
      const response = await this.api("getsThreadPostList", { fid: "", tid: id, order: "score", page: "1" })
      return this.buildComments(response.data?.result?.list || [])
    })
    return this.result({
      contentId: data.tid || id, title: post.title, content, comments,
      author: this.createAuthor(data.author?.name, data.author?.header, null, this.headers, { id: data.author?.puid }),
      timestamp: post.create_time, url: "https://m.hupu.com/bbs/" + (data.tid || id) + ".html",
      stats: this.createStats({ views: data.author?.view, likes: data.recommend_num, shares: post.share_num, comments: post.replies }),
    })
  }
}

export class LofterApiParser extends OpenGraphParser {
  author(user = {}, location) {
    return this.createAuthor(user.blogNickName, user.bigAvaImg, null, this.headers, { id: user.blogName, location })
  }
  comment(row, depth = 0) {
    const text = htmlToText(row.content, "https://www.lofter.com/")
    const emotes = (row.emotes || []).filter(emote => emote.name && emote.url).sort((a, b) => b.name.length - a.name.length)
    const content = []
    let cursor = 0, plain = ""
    while (cursor < text.length) {
      const found = emotes.find(emote => text.startsWith(emote.name, cursor))
      if (!found) { plain += text[cursor++]; continue }
      if (plain) content.push(plain)
      plain = ""
      content.push(this.createSticker(found.url, "small", found.name))
      cursor += found.name.length
    }
    if (plain) content.push(plain)
    return this.createComment({
      author: this.author(row.publisherBlogInfo, row.ipLocation), content,
      timestamp: Number(row.publishTime) / 1000,
      stats: this.createStats({ likes: row.likeCount, comments: row.l2Comments?.length }),
      replies: depth < 10 ? (row.l2Comments || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }
  async parse(match) {
    if (match[0].includes("s.lofter.com/")) return this.parseWithRedirect(sourceUrl(match))
    const ids = /post\/([0-9a-z]+)_([0-9a-z]+)/i.exec(match[0])
    if (!ids) throw new ParseError("LOFTER 链接无法识别")
    let blogId, postId
    try {
      blogId = BigInt("0x" + ids[1]).toString()
      postId = BigInt("0x" + ids[2]).toString()
    } catch { throw new ParseError("LOFTER 帖子 ID 格式不正确") }
    const value = await http.json("https://api.lofter.com/oldapi/post/detail.api", {
      method: "POST", params: { product: "lofter-android-8.1.20" },
      body: new URLSearchParams({ postid: postId, targetblogid: blogId }), headers: this.headers,
    })
    const post = value.response?.posts?.[0]?.post
    if (Number(value.meta?.status) !== 200 || !post) throw new ParseError("LOFTER 帖子不存在或暂不可访问")
    let photos = []
    try { photos = typeof post.photoLinks === "string" ? JSON.parse(post.photoLinks) : post.photoLinks || [] } catch {}
    const content = richHtml(this, post.content, "https://www.lofter.com/")
    const existing = new Set(content.filter(item => typeof item === "object").map(item => item.pathTask?.url))
    content.push(...this.createImages(photos.map(photo => photo.orign || photo.origin).filter(url => url && !existing.has(url))))
    const comments = await optionalComments(async () => {
      const response = await http.json("https://www.lofter.com/comment/l1/hotnew.json", {
        params: { postId, blogId }, headers: this.headers,
      })
      return response.code === 0 ? [...(response.data?.hotList || []), ...(response.data?.list || [])].map(row => this.comment(row)) : []
    })
    return this.result({
      contentId: postId, title: post.title, author: this.author(post.blogInfo, post.ipLocation),
      content, timestamp: Number(post.publishTime) / 1000,
      url: "https://" + post.blogInfo.blogName + ".lofter.com/post/" + ids[1] + "_" + ids[2],
      stats: this.createStats({ likes: post.postCount?.favoriteCount, shares: post.postCount?.shareCount, comments: post.postCount?.responseCount }),
      comments,
    })
  }
}

export class WmpvpApiParser extends OpenGraphParser {
  constructor() {
    super()
    this.headers = { ...this.headers, referer: "https://news.wmpvp.com/" }
  }
  comment(row, depth = 0) {
    const user = row.userDTO || row.fromUserDTO || {}
    return this.createComment({
      author: this.createAuthor(user.userName, user.avatar, null, this.headers, { id: user.userId, location: row.userRegion }),
      content: [row.content, ...(row.image ? [this.createImage(row.image, null, this.headers)] : [])].filter(Boolean),
      timestamp: Number(row.createTime) / 1000,
      stats: this.createStats({ likes: row.likeCount, comments: row.replyCount }),
      replies: depth < 10 ? (row.replyComments || []).map(child => this.comment(child, depth + 1)) : [],
    })
  }
  async parse(match, route) {
    const params = query(match, route)
    const id = params.id
    const news = /\/news\.html/.test(match[0])
    const headers = { ...this.headers, referer: "https://news.wmpvp.com/" }
    const data = await http.json(news
      ? "https://appactivity.wmpvp.com/steamcn/app/news/getAppNewsById"
      : "https://appengine.wmpvp.com/steamcn/community/post/getPostById", {
      headers, params: news ? { newsId: id, gameType: params.gameTypeStr } : { postId: id },
    })
    const post = news ? data.result?.news : data.result?.post
    if (!post) throw new ParseError("完美世界电竞内容不存在")
    const content = news ? richHtml(this, post.content, "https://news.wmpvp.com/", { headers, imageLayout: "grid" })
      : [htmlToText(post.content, "https://news.wmpvp.com/"), ...this.createImages((post.images || []).map(image => image.url), headers)].filter(Boolean)
    const video = post.videoInfo
    if (video?.playInfoList?.[0]?.playURL) content.push(this.createVideo(
      video.playInfoList[0].playURL, video.videoBase?.coverURL, Number(video.videoBase?.duration), { headers },
    ))
    const comments = await optionalComments(async () => {
      const response = await http.json("https://gwapi.pwesports.cn/appuser/community/comment/getCommentList", {
        headers, params: { entityId: id, entityType: news ? 2 : 11, pageNum: 1, pageSize: config.parser_max_comments,
          sort: 4, type: 1, onlyOwner: false, ratingType: 0 },
      })
      return (response.result?.commentResponse?.commentDTOS || []).map(row => this.comment(row))
    })
    return this.result({
      contentId: (news ? "news:" : "post:") + id, title: post.title, content, comments,
      author: this.createAuthor(post.communityUserItem?.nickname, post.communityUserItem?.avatar, null, headers, {
        id: post.communityUserItem?.userId, location: post.userRegion,
      }),
      timestamp: Number(news ? post.publishTime : post.gmtCreate) / 1000,
      url: post.postUrl || sourceUrl(match),
      stats: this.createStats({ views: post.pageViewCount ?? post.readTotalCount, likes: post.likeCount ?? post.likeCountTotal, comments: post.replyCount }),
    })
  }
}
