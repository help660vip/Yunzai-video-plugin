import { BaseParser } from "../core/registry.js"
import { cacheLifecycle } from "../core/cache-lifecycle.js"
import { config } from "../core/config.js"
import { DownloadError, IgnoreError, ParseError } from "../core/errors.js"
import { PathTask } from "../core/model.js"
import { cacheDir } from "../core/paths.js"
import { biliApi, biliUrl } from "./bilibili-api.js"
import { sanitizeBiliStreamUrls, probeBiliSourceSize } from "./bilibili-cdn.js"
import { buildBiliPost, buildBiliComments } from "./bilibili-content.js"
import { bvToAv } from "./bilibili-rpc.js"
import { load } from "cheerio"

function dynamicAuthor(item) {
  return item?.modules?.module_author || {}
}

function dynamicModule(item) {
  return item?.modules?.module_dynamic || {}
}

function dynamicMajor(item) {
  return dynamicModule(item).major || dynamicModule(item)
}

function dynamicText(item) {
  const module = dynamicModule(item)
  const major = dynamicMajor(item)
  return (
    module.desc?.text ||
    major?.archive?.desc ||
    major?.opus?.summary?.text ||
    major?.desc?.text ||
    null
  )
}

function dynamicImages(item) {
  const major = dynamicMajor(item)
  if (major?.opus?.pics) return major.opus.pics.map(pic => biliUrl(pic.url)).filter(Boolean)
  if (major?.draw?.items) return major.draw.items.map(pic => biliUrl(pic.src)).filter(Boolean)
  if (major?.archive?.cover) return [biliUrl(major.archive.cover)]
  return []
}

function paragraphText(nodes = []) {
  return nodes
    .filter(node => ["TEXT_NODE_TYPE_WORD", "TEXT_NODE_TYPE_RICH"].includes(node.type))
    .map(node => node.word?.words || "")
    .join("")
}

export function selectBilibiliPage(info, pageNum = 1) {
  const pages = info.pages || []
  let pageIndex = pageNum - 1
  let title = info.title
  let duration = Number(info.duration || 0)
  let cover = biliUrl(info.pic)
  let timestamp = info.pubdate
  if (pages.length > 1) {
    pageIndex = ((pageIndex % pages.length) + pages.length) % pages.length
    const page = pages[pageIndex]
    title += ` | 分集 - ${page.part}`
    duration = Number(page.duration || 0)
    cover = biliUrl(page.first_frame) || cover
    timestamp = page.ctime || timestamp
  }
  if (pages.length === 1) pageIndex = 0
  return { pageIndex, title, duration, cover, timestamp, page: pages[pageIndex] }
}

export function selectBilibiliStreams(data, quality, codePriority, audioQuality = null) {
  const rank = id => [30216, 30232, 30280, 30251, 30250].indexOf(Number(id))
  const media = data.media
  const videos = media ? (media.video || []).filter(item => item.dash?.url).map(item => ({
    id: item.info?.quality, baseUrl: item.dash.url, backupUrl: item.dash.backups || [],
    codecs: { 7: "avc", 12: "hev", 13: "av01" }[item.dash.codec] || "",
    size: Number(item.dash.size || 0), bandwidth: item.dash.bitrate,
  })) : [...(data.dash?.video || [])]
  const pool = videos.filter(item => Number(item.id) <= quality && ![125, 126].includes(Number(item.id)))
  pool.sort((left, right) => {
    const qualityDiff = Number(right.id) - Number(left.id)
    if (qualityDiff) return qualityDiff
    const leftCode = codePriority.findIndex(code => String(left.codecs).startsWith(code))
    const rightCode = codePriority.findIndex(code => String(right.codecs).startsWith(code))
    return (leftCode < 0 ? 99 : leftCode) - (rightCode < 0 ? 99 : rightCode)
  })
  const video = pool.find(item =>
    codePriority.some(code => String(item.codecs || "").startsWith(code)),
  )
  const audios = (media ? [
    ...(media.audio || []), media.lossless?.audio, media.dolby?.audio,
  ].filter(Boolean).map(item => ({
    id: item.quality, baseUrl: item.url, backupUrl: item.backups || [],
    size: Number(item.size || 0), bandwidth: item.bitrate,
  })) : [
    ...(data.dash?.audio || []),
    ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : []),
    ...(Array.isArray(data.dash?.dolby?.audio) ? data.dash.dolby.audio : data.dash?.dolby?.audio ? [data.dash.dolby.audio] : []),
  ]).filter(item => audioQuality === null || (rank(item.id) >= 0 && rank(item.id) <= rank(audioQuality))).sort(
    (left, right) => rank(left.id) >= 0 && rank(right.id) >= 0 ? rank(right.id) - rank(left.id) : Number(right.bandwidth || right.id) - Number(left.bandwidth || left.id),
  )
  if (!video) {
    const segmented = media?.video?.find(item => item.segments?.items?.length && Number(item.info?.quality || 0) <= quality)?.segments?.items || data.durl
    if (segmented?.length) return { video: { baseUrl: segmented[0].url, backupUrl: segmented[0].backups || segmented[0].backup_url || [], segments: segmented }, audio: null }
  }
  return { video, audio: audios[0] || null }
}

export class BilibiliParser extends BaseParser {
  static BILI_RETRYABLE_HTTP_STATUSES = new Set([
    403,
    404,
    408,
    425,
    429,
    ...Array.from({ length: 100 }, (_, index) => 500 + index),
  ])
  static platform = { name: "bilibili", displayName: "哔哩哔哩" }
  static handlers = [
    {
      keyword: "bilibili.com/bangumi/play",
      pattern: /bilibili\.com\/bangumi\/play\/(?:(?:ep(?<epId>\d+))|(?:ss(?<seasonId>\d+)))/,
      method: "parseBangumiMatch",
    },
    {
      keyword: "bilibili.com/list/watchlater",
      pattern: /bilibili\.com\/list\/watchlater[^\s]*/,
      params: { bvid: {}, p: { default: "1", asInt: true, required: false } },
      method: "parseWatchlater",
    },
    {
      keyword: "search.bilibili.com",
      pattern: /search\.bilibili\.com\/[^\s]*/,
      params: { keyword: {} },
      method: "parseSearch",
    },
    {
      keyword: "bili2233",
      pattern: /bili2233\.cn\/[0-9a-zA-Z._?%&+\-=/#]+/,
      method: "parseShort",
    },
    {
      keyword: "b23.tv",
      pattern: /b23\.tv\/[0-9a-zA-Z._?%&+\-=/#]+/,
      method: "parseShort",
    },
    {
      keyword: "/dynamic/",
      pattern: /bilibili\.com\/dynamic\/(?<dynamicId>\d+)/,
      method: "parseDynamicMatch",
    },
    {
      keyword: "/opus/",
      pattern: /bilibili\.com\/opus\/(?<dynamicId>\d+)/,
      method: "parseDynamicMatch",
    },
    {
      keyword: "t.bili",
      pattern: /t\.bilibili\.com\/(?<dynamicId>\d+)/,
      method: "parseDynamicMatch",
    },
    {
      keyword: "live.bili",
      pattern: /live\.bilibili\.com\/(?<roomId>\d+)/,
      method: "parseLiveMatch",
    },
    {
      keyword: "/favlist",
      pattern: /favlist\?fid=(?<favId>\d+)/,
      method: "parseFavMatch",
    },
    {
      keyword: "/read/",
      pattern: /bilibili\.com\/read\/cv(?<readId>\d+)/,
      method: "parseReadMatch",
    },
    {
      keyword: "/BV",
      pattern:
        /bilibili\.com(?:\/video)?\/(?<bvid>BV[0-9A-Za-z]{10})(?:.*?[?&]p=(?<pageNum>\d{1,3}))?/,
      method: "parseBv",
    },
    {
      keyword: "BV",
      pattern: /^(?<bvid>BV[0-9a-zA-Z]{10})(?:\s)?(?<pageNum>\d{1,3})?$/,
      method: "parseBv",
    },
    {
      keyword: "/av",
      pattern:
        /bilibili\.com(?:\/video)?\/av(?<avid>\d{6,})(?:.*?[?&]p=(?<pageNum>\d{1,3}))?/,
      method: "parseAv",
    },
    {
      keyword: "av",
      pattern: /^av(?<avid>\d{6,})(?:\s)?(?<pageNum>\d{1,3})?$/,
      method: "parseAv",
    },
    {
      keyword: "space.bilibili.com",
      pattern: /space\.bilibili\.com\/(?<mid>\d+)(?!\d)\/?(?=[?#\s]|$)/,
      method: "parseUserMatch",
    },
  ]

  constructor() {
    super()
    this.headers = {
      referer: "https://www.bilibili.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    }
  }

  async readyCredential() {
    const credential = await biliApi.credential()
    delete this.headers.cookie
    this.headers = { ...this.headers, ...biliApi.headers }
    return credential
  }

  parseShort(match) {
    return this.parseWithRedirect(`https://${match[0]}`)
  }

  parseBv(match) {
    return this.parseVideo({
      bvid: match.groups.bvid,
      pageNum: Number(match.groups.pageNum || 1),
    })
  }

  parseAv(match) {
    return this.parseVideo({
      avid: Number(match.groups.avid),
      pageNum: Number(match.groups.pageNum || 1),
    })
  }

  parseDynamicMatch(match) {
    return this.parseDynamicOrOpus(match.groups.dynamicId)
  }

  parseLiveMatch(match) {
    return this.parseLive(Number(match.groups.roomId))
  }

  parseFavMatch(match) {
    return this.parseFavlist(Number(match.groups.favId))
  }

  parseReadMatch(match) {
    return this.parseArticle(Number(match.groups.readId))
  }

  parseBangumiMatch(match) { return this.parseBangumi(match.groups) }

  parseWatchlater(match, route) {
    return this.parseVideo({ bvid: route.params.bvid, pageNum: Number(route.params.p || 1) })
  }

  parseUserMatch(match) { return this.parseUser(match.groups.mid) }

  async parseSearch(match, route) {
    const keyword = route.params.keyword
    const data = await biliApi.search(keyword)
    const items = Array.isArray(data.items) ? data.items : Object.values(data.items || {}).flat()
    return this.result({
      contentId: "search:" + keyword, title: "搜索：" + keyword,
      url: "https://search.bilibili.com/all?keyword=" + encodeURIComponent(keyword),
      content: items.slice(0, 20).map(item => this.createLink(item.uri?.startsWith("http") ? item.uri : item.goto === "mid" || item.goto === "space" ? "https://space.bilibili.com/" + (item.mid || item.param) : item.bvid ? "https://www.bilibili.com/video/" + item.bvid : item.season_id ? "https://www.bilibili.com/bangumi/play/ss" + item.season_id : "https://www.bilibili.com/video/av" + item.param, {
        title: load("<div>" + (item.title || "") + "</div>")("div").text(),
        previewUrl: biliUrl(item.cover), description: item.author || item.sign || item.style, siteName: "哔哩哔哩",
      })),
    })
  }

  async parseUser(mid) {
    await this.readyCredential()
    const data = await biliApi.userInfo(mid)
    const card = data.card || {}
    const content = [card.sign].filter(Boolean)
    if (data.live?.roomStatus === 1) content.push(this.createLink("https://live.bilibili.com/" + data.live.roomid, {
      title: data.live.title, description: data.live.liveStatus === 1 ? "直播中" : "未开播", previewUrl: biliUrl(data.live.cover),
    }))
    return this.result({ contentId: "user:" + mid, url: "https://space.bilibili.com/" + mid, title: card.name, content,
      author: this.createAuthor(card.name, biliUrl(card.face), card.sign, this.headers, { id: String(card.mid || mid) }) })
  }

  async parseBangumi({ epId, seasonId }) {
    const data = await biliApi.bangumi({ epId, seasonId })
    const stat = data.stat || {}
    return this.result({
      contentId: epId ? "ep:" + epId : "ss:" + seasonId,
      url: data.share_url || "https://www.bilibili.com/bangumi/play/" + (epId ? "ep" + epId : "ss" + seasonId),
      title: data.title, author: this.createAuthor(data.season_title || data.title, biliUrl(data.square_cover)),
      content: [data.cover ? this.createGraphic(biliUrl(data.cover)) : null, data.evaluate].filter(Boolean),
      stats: this.createStats({ views: stat.views, likes: stat.likes, favorites: stat.favorite, shares: stat.share, comments: stat.reply, extra: { danmaku: ["弹幕", stat.danmakus], coin: ["硬币", stat.coins] } }),
    })
  }

  async videoInfo({ bvid, avid }) {
    try {
      const data = await biliApi.videoDetail({ bvid, avid })
      if (data.error || !data.video?.aid) throw new ParseError("获取视频信息失败")
      const video = data.video
      return {
        aid: video.aid, bvid: data.bvid || bvid, title: video.title, desc: video.description,
        pic: video.cover, pubdate: video.published, duration: video.duration, stat: video.counts || {},
        owner: { mid: video.author?.id, name: video.author?.name, face: video.author?.avatar },
        pages: (data.pages || []).map(({ video: page }) => ({ cid: page.cid, part: page.title, duration: page.duration, first_frame: page.cover })),
      }
    } catch {}
    const params = bvid ? { bvid } : { aid: avid }
    return biliApi.json("https://api.bilibili.com/x/web-interface/view", { params })
  }

  async parseVideo({ bvid = null, avid = null, pageNum = 1 }) {
    const credential = await this.readyCredential()
    const info = await this.videoInfo({ bvid, avid })
    bvid = info.bvid
    const { pageIndex, title, duration, cover, timestamp, page } = selectBilibiliPage(
      info,
      pageNum,
    )
    let summary = "哔哩哔哩 cookie 未配置或失效, 无法使用 AI 总结"
    if (credential) {
      if (!page?.cid) throw new ParseError("不存在该分 P")
      try {
      const params = await biliApi.signWbi({
        aid: info.aid,
        bvid,
        cid: page.cid,
        up_mid: info.owner?.mid,
        web_location: "333.788",
      })
      const ai = await biliApi.json(
        "https://api.bilibili.com/x/web-interface/view/conclusion/get",
        { params },
      )
      summary = ai.model_result?.summary
        ? `AI总结: ${ai.model_result.summary}`
        : "该视频暂不支持AI总结"
      } catch { summary = null }
    }

    const selectedPage = pageIndex + 1
    const variant = [config.parser_bili_video_quality, config.parser_bili_audio_quality || 30280, ...(config.parser_bili_video_codes || [])].join("-")
    const fileName = `${bvid}-${selectedPage}-${variant}.mp4`
    let initialStreams = null
    // Metadata and HEAD probes do not start a media task. Download remains deferred.
    try {
      initialStreams = await this.extractDownloadStreams({ bvid, avid: info.aid, cid: page?.cid, pageIndex })
    } catch {}
    let media
    const task = new PathTask(async () => {
      if (duration > config.parser_duration_maximum) throw new IgnoreError("视频时长超过限制")
      const outputPath = `${cacheDir}/${fileName}`
      const fs = await import("node:fs")
      if (fs.existsSync(outputPath)) {
        await cacheLifecycle.touch(outputPath)
        return outputPath
      }
      const { videoUrls, audioUrls, sourceSize } = initialStreams || await this.extractDownloadStreams({
        bvid,
        avid: info.aid,
        cid: page?.cid,
        pageIndex,
      })
      media.sizeBytes = sourceSize || null
      if (audioUrls?.length) {
        return this.downloader.downloadAVAndMerge(videoUrls[0], audioUrls[0], {
          outputPath,
          headers: this.headers,
          videoFallbackUrls: videoUrls.slice(1),
          audioFallbackUrls: audioUrls.slice(1),
          retryHttpStatuses: BilibiliParser.BILI_RETRYABLE_HTTP_STATUSES,
        })
      }
      return this.downloader.download(videoUrls[0], {
        fileName,
        headers: this.headers,
        fallbackUrls: videoUrls.slice(1),
        retryHttpStatuses: BilibiliParser.BILI_RETRYABLE_HTTP_STATUSES,
      })
    }, `bilibili:${bvid}:${selectedPage}:${variant}`)
    media = this.createVideo(task, cover, duration, { headers: this.headers })
    media.sizeBytes = initialStreams?.sourceSize || null
    const stat = info.stat || {}
    const comments = await this.fetchComments(info.aid, 1)

    return this.result({
      contentId: bvid + ":" + pageIndex,
      url: `https://bilibili.com/${bvid}${pageIndex > 0 ? `?p=${pageIndex + 1}` : ""}`,
      title,
      timestamp,
      text: info.desc,
      author: this.createAuthor(info.owner?.name, biliUrl(info.owner?.face), null, this.headers, { id: String(info.owner?.mid || "") }),
      contents: [media],
      stats: this.createStats({ views: stat.views ?? stat.view, likes: stat.likes ?? stat.like,
        favorites: stat.favorites ?? stat.favorite, comments: stat.comments ?? stat.reply, shares: stat.shares ?? stat.share,
        extra: { danmaku: ["弹幕", stat.danmaku], coin: ["硬币", stat.coins ?? stat.coin] } }),
      comments, aiSummary: summary,
      embedUrl: `https://player.bilibili.com/player.html?aid=${info.aid}&autoplay=1&p=${selectedPage}`,
      extra: { info: summary },
    })
  }

  async extractDownloadStreams({ bvid = null, avid = null, cid = null, pageIndex = 0 }) {
    await this.readyCredential()
    if (!cid) {
      const info = await this.videoInfo({ bvid, avid })
      cid = info.pages?.[pageIndex]?.cid
      bvid = info.bvid
      avid = info.aid
    }
    let data
    try {
      data = await biliApi.playback({
        aid: avid || bvToAv(bvid), cid,
        quality: config.parser_bili_video_quality, codecs: config.parser_bili_video_codes,
      })
      if (!data.media?.video?.length) throw new DownloadError("视频流为空")
    } catch {
    const params = await biliApi.signWbi({
      qn: config.parser_bili_video_quality,
      fnval: 4048,
      fnver: 0,
      fourk: 1,
      gaia_source: "pre-load",
      isGaiaAvoided: "true",
      avid,
      bvid,
      cid,
      from_client: "BROWSER",
      web_location: 1315873,
    })
    data = await biliApi.json("https://api.bilibili.com/x/player/wbi/playurl", {
      params,
    })
    }
    const { video, audio } = selectBilibiliStreams(
      data,
      config.parser_bili_video_quality,
      config.parser_bili_video_codes,
      config.parser_bili_audio_quality || 30280,
    )
    if (!video) throw new DownloadError("未找到可下载的视频流")
    const videoUrls = sanitizeBiliStreamUrls(video, {
        region: config.parser_bili_cdn_region,
        domain: config.parser_bili_cdn_domain,
      })
    const audioUrls = sanitizeBiliStreamUrls(audio, {
        region: config.parser_bili_cdn_region,
        domain: config.parser_bili_cdn_domain,
      })
    if (!videoUrls?.length) throw new DownloadError("未找到可下载的视频地址")
    const sizes = await Promise.all([videoUrls, audioUrls].map(urls =>
      probeBiliSourceSize(urls, url => this.downloader.headSize(url, { headers: this.headers }))))
    return { videoUrls, audioUrls, sourceSize: sizes.reduce((sum, value) => sum + (value || 0), 0) || null, audioQuality: audio?.id || null }
  }

  async extractDownloadUrls(options) {
    const { videoUrls, audioUrls } = await this.extractDownloadStreams(options)
    return [videoUrls?.[0] || null, audioUrls?.[0] || null]
  }

  async parseDynamicOrOpus(id) {
    await this.readyCredential()
    try {
      const data = await biliApi.postDetail(id)
      if (!data.post) throw new ParseError("获取动态信息失败")
      if ([7, 8].includes(data.post.kind)) return await this.parseOpus(id)
      const result = buildBiliPost(this, data.post, { id })
      const video = data.post.blocks?.find(block => block.media?.video)?.media.video
      if (video?.bvid && data.post.kind === 2) {
        const parsed = await this.parseVideo({ bvid: video.bvid })
        parsed.text = result.content.filter(item => typeof item === "string").join("") || parsed.text
        parsed.extra.content_type = "动态"
        return parsed
      }
      result.comments = await this.fetchComments(video?.aid || id, video?.aid ? 1 : 17)
      return result
    } catch {}
    const data = await biliApi.json(
      "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail",
      { params: { id, features: "itemOpusStyle" } },
    )
    const item = data.item
    if (!item) throw new ParseError("获取动态信息失败")
    if (dynamicMajor(item)?.type === "MAJOR_TYPE_OPUS") {
      return this.parseOpus(id)
    }
    return this.collectDynamic(item)
  }

  async collectDynamic(item) {
    const major = dynamicMajor(item)
    if (major?.archive?.bvid) {
      const result = await this.parseVideo({ bvid: major.archive.bvid })
      result.text = dynamicText(item)
      result.extra.content_type = "动态"
      return result
    }
    const author = dynamicAuthor(item)
    const result = this.result({
      contentId: item.id_str || item.id || null,
      title: major?.opus?.title || major?.archive?.title || null,
      text: dynamicText(item),
      timestamp: author.pub_ts,
      author: this.createAuthor(author.name, biliUrl(author.face), null, this.headers),
      contents: this.createImages(dynamicImages(item), this.headers),
      extra: { content_type: "动态" },
    })
    if (item.type === "DYNAMIC_TYPE_FORWARD" && item.orig) {
      result.repost = await this.collectDynamic(item.orig)
    }
    return result
  }

  async parseOpus(id) {
    try {
      const data = await biliApi.articleDetail(id)
      if (!data.article) throw new ParseError("获取图文信息失败")
      const result = buildBiliPost(this, data.article, { id, article: true })
      result.comments = await this.fetchComments(data.article.originalId || data.article.id || id, data.article.kind === 1 ? 12 : 11)
      return result
    } catch {}
    const data = await biliApi.json(
      "https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail",
      { params: { id } },
    )
    const item = data.item || data
    const modules = Array.isArray(item.modules) ? item.modules : []
    const author = modules.find(module => module.module_author)?.module_author
    const result = this.result({
      contentId: id,
      author: author
        ? this.createAuthor(author.name, biliUrl(author.face), null, this.headers)
        : null,
      title: item.basic?.title || null,
      timestamp: author?.pub_ts ? Number(author.pub_ts) : null,
    })
    const content = modules.find(module => module.module_content)?.module_content
    const paragraphs = content?.paragraphs || []
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index]
      const text = paragraphText(paragraph.text?.nodes).trim()
      if (text) result.graphics.push(text)
      if (paragraph.pic?.pics?.length) {
        for (const pic of paragraph.pic.pics) {
          const image = this.createImage(biliUrl(pic.url), null, this.headers)
          const next = paragraphs[index + 1]
          if (next) index += 1
          if (next?.text?.nodes?.length) {
            let trailing = ""
            for (const node of next.text.nodes) {
              if (!["TEXT_NODE_TYPE_WORD", "TEXT_NODE_TYPE_RICH"].includes(node.type)) continue
              const words = node.word?.words || ""
              if (node.word?.color === "#999999") image.alt = words
              else trailing += words
            }
            result.graphics.push(image)
            if (trailing.trim()) result.graphics.push(trailing.trim())
          } else {
            result.graphics.push(image)
          }
        }
      }
    }
    return result
  }

  async parseArticle(readId) {
    try {
      const info = await biliApi.json("https://api.bilibili.com/x/article/viewinfo", {
        params: { id: readId, mobi_app: "pc", from: "web" },
      })
      if (info.opus_id) return this.parseOpus(String(info.opus_id))
    } catch {}

    let info
    try {
    info = await biliApi.json("https://api.bilibili.com/x/article/view", {
      params: { id: readId },
    })
    } catch {
      const data = await biliApi.articleDetail(readId, 1)
      if (!data.article) throw new ParseError("获取专栏信息失败")
      const result = buildBiliPost(this, data.article, { id: readId, article: true })
      result.comments = await this.fetchComments(data.article.originalId || readId, 12)
      return result
    }
    const $ = load(info.content || "")
    const graphics = []
    $("p,img").each((_, element) => {
      if (element.tagName === "p") {
        const text = $(element).text().trim()
        if (text) graphics.push(text)
        return
      }
      const source = $(element).attr("data-src") || $(element).attr("src")
      if (source) graphics.push(this.createImage(biliUrl(source), $(element).attr("alt"), this.headers))
    })
    return this.result({
      contentId: "cv" + readId,
      url: "https://www.bilibili.com/read/cv" + readId,
      title: info.title,
      text: info.summary,
      timestamp: info.publish_time || info.ctime,
      author: this.createAuthor(
        info.author?.name,
        biliUrl(info.author?.face),
        info.author?.sign,
        this.headers,
        { id: info.author?.mid },
      ),
      graphics,
      stats: this.createStats({
        views: info.stats?.view,
        likes: info.stats?.like,
        comments: info.stats?.reply,
        shares: info.stats?.share,
      }),
      extra: { content_type: "专栏" },
    })
  }

  async parseLive(roomId) {
    await this.readyCredential()
    let data
    try {
    data = await biliApi.json(
      "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom",
      { params: { room_id: roomId } },
    )
    } catch {
      const room = await biliApi.json("https://api.live.bilibili.com/room/v1/Room/get_info", { params: { room_id: roomId } })
      let card = {}
      try { card = (await biliApi.userInfo(room.uid)).card || {} } catch {}
      data = { room_info: room, anchor_info: { base_info: { uname: card.name || String(room.uid || ""), face: card.face } } }
    }
    const room = data.room_info || {}
    const anchor = data.anchor_info?.base_info || {}
    return this.result({
      contentId: "live:" + (room.room_id || roomId),
      url: `https://www.bilibili.com/blackboard/live/live-activity-player.html?enterTheRoom=0&cid=${roomId}`,
      title: `直播 - ${room.title || ""}`,
      text: `${{ 0: "未开播", 1: "直播中", 2: "轮播中" }[room.live_status] || ""}\n分区: ${room.area_name || ""} | ${room.parent_area_name || ""}\n${load(room.description || "").text()}`,
      contents: this.createImages(
        [biliUrl(room.cover || room.user_cover), biliUrl(room.keyframe)].filter(Boolean),
        this.headers,
      ),
      author: this.createAuthor(anchor.uname, biliUrl(anchor.face), null, this.headers, { id: String(room.uid || "") }),
      timestamp: room.live_start_time || (room.live_time && !room.live_time.startsWith("0000") ? Date.parse(room.live_time.replace(" ", "T") + "+08:00") / 1000 : null),
    })
  }

  async parseFavlist(favId) {
    const data = await biliApi.json("https://api.bilibili.com/x/v3/fav/resource/list", {
      params: {
        media_id: favId,
        pn: 1,
        ps: 20,
        keyword: "",
        order: "mtime",
        type: 0,
        tid: 0,
        platform: "web",
      },
    })
    if (data.medias === null) throw new ParseError("收藏夹内容为空, 或被风控")
    const info = data.info || {}
    const graphics = []
    for (const media of data.medias || []) {
      const url = String(media.link || "").replace(
        "bilibili://video/",
        "https://bilibili.com/video/av",
      )
      const description = `标题: ${media.title}\n简介: ${media.intro}\n链接: ${url}`
      graphics.push(this.createImage(biliUrl(media.cover), description, this.headers))
      graphics.push(description)
    }
    return this.result({
      title: `收藏夹 - ${info.title || ""}`,
      timestamp: info.ctime,
      contentId: favId,
      url: `https://space.bilibili.com/${info.upper?.mid || ""}/favlist?fid=${favId}`,
      author: this.createAuthor(info.upper?.name, biliUrl(info.upper?.face), null, this.headers),
      graphics,
    })
  }

  async fetchComments(id, kind = 1) {
    const limit = Number(config.parser_max_comments ?? 5)
    if (!limit || !id) return []
    try { return buildBiliComments(this, await biliApi.comments(id, kind), limit) }
    catch {
      try {
        const data = await biliApi.json("https://api.bilibili.com/x/v2/reply", {
          params: { oid: String(id), type: kind, pn: 1, ps: Math.min(20, limit), sort: 2 },
        })
        const convert = (item, depth = 0) => ({
          id: item.rpid_str || String(item.rpid || ""), likes: item.like, published: item.ctime, count: item.rcount,
          author: { id: item.member?.mid, name: item.member?.uname, avatar: item.member?.avatar },
          body: { text: item.content?.message, emotes: item.content?.emote, pictures: (item.content?.pictures || []).map(pic => ({ url: pic.img_src })) },
          context: { location: item.reply_control?.location },
          replies: depth < 1 ? (item.replies || []).slice(0, 5).map(reply => convert(reply, depth + 1)) : [],
        })
        return buildBiliComments(this, {
          pinned: data.upper?.top ? convert(data.upper.top) : null,
          replies: [...(data.hots || []), ...(data.replies || [])].map(item => convert(item)),
        }, limit)
      } catch { return [] }
    }
  }
}
