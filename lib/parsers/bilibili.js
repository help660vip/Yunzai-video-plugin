import { BaseParser } from "../core/registry.js"
import { cacheLifecycle } from "../core/cache-lifecycle.js"
import { config } from "../core/config.js"
import { DownloadError, IgnoreError, ParseError } from "../core/errors.js"
import { PathTask } from "../core/model.js"
import { cacheDir } from "../core/paths.js"
import { biliApi, biliUrl } from "./bilibili-api.js"
import { sanitizeBiliStreamUrls } from "./bilibili-cdn.js"
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
    cover = biliUrl(page.first_frame)
    timestamp = page.ctime
  }
  return { pageIndex, title, duration, cover, timestamp, page: pages[pageIndex] }
}

export function selectBilibiliStreams(data, quality, codePriority) {
  const videos = [...(data.dash?.video || [])]
  const available = videos.filter(item => Number(item.id) <= quality)
  const pool = available.length ? available : videos
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
  const audios = [
    ...(data.dash?.audio || []),
    ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : []),
    ...(data.dash?.dolby?.audio ? [data.dash.dolby.audio] : []),
  ].sort(
    (left, right) => Number(right.bandwidth || right.id) - Number(left.bandwidth || left.id),
  )
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
    return this.parseDynamicOrOpus(Number(match.groups.dynamicId))
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

  async videoInfo({ bvid, avid }) {
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
    }

    const task = new PathTask(async () => {
      const outputPath = `${cacheDir}/${bvid}-${pageNum}.mp4`
      const fs = await import("node:fs")
      if (fs.existsSync(outputPath)) {
        await cacheLifecycle.touch(outputPath)
        return outputPath
      }
      const { videoUrls, audioUrls } = await this.extractDownloadStreams({
        bvid,
        avid: info.aid,
        cid: page?.cid,
        pageIndex,
      })
      if (duration > config.parser_duration_maximum) throw new IgnoreError("视频时长超过限制")
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
        fileName: `${bvid}-${pageNum}.mp4`,
        headers: this.headers,
        fallbackUrls: videoUrls.slice(1),
        retryHttpStatuses: BilibiliParser.BILI_RETRYABLE_HTTP_STATUSES,
      })
    }, `bilibili:${bvid}:${pageNum}`)

    return this.result({
      contentId: bvid + ":" + pageIndex,
      url: `https://bilibili.com/${bvid}${pageIndex > 0 ? `?p=${pageIndex + 1}` : ""}`,
      title,
      timestamp,
      text: info.desc,
      author: this.createAuthor(info.owner?.name, biliUrl(info.owner?.face), null, this.headers),
      contents: [this.createVideo(task, cover, duration, { headers: this.headers })],
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
    const params = await biliApi.signWbi({
      qn: 127,
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
    const data = await biliApi.json("https://api.bilibili.com/x/player/wbi/playurl", {
      params,
    })
    const { video, audio } = selectBilibiliStreams(
      data,
      config.parser_bili_video_quality,
      config.parser_bili_video_codes,
    )
    if (!video) throw new DownloadError("未找到可下载的视频流")
    return {
      videoUrls: sanitizeBiliStreamUrls(video, {
        region: config.parser_bili_cdn_region,
        domain: config.parser_bili_cdn_domain,
      }),
      audioUrls: sanitizeBiliStreamUrls(audio, {
        region: config.parser_bili_cdn_region,
        domain: config.parser_bili_cdn_domain,
      }),
    }
  }

  async extractDownloadUrls(options) {
    const { videoUrls, audioUrls } = await this.extractDownloadStreams(options)
    return [videoUrls?.[0] || null, audioUrls?.[0] || null]
  }

  async parseDynamicOrOpus(id) {
    await this.readyCredential()
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
      if (info.opus_id) return this.parseOpus(Number(info.opus_id))
    } catch {}

    const info = await biliApi.json("https://api.bilibili.com/x/article/view", {
      params: { id: readId },
    })
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
    const data = await biliApi.json(
      "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom",
      { params: { room_id: roomId } },
    )
    const room = data.room_info || {}
    const anchor = data.anchor_info?.base_info || {}
    return this.result({
      contentId: roomId,
      url: `https://www.bilibili.com/blackboard/live/live-activity-player.html?enterTheRoom=0&cid=${roomId}`,
      title: `直播 - ${room.title || ""}`,
      text: `分区: ${room.area_name || ""} | ${room.parent_area_name || ""}\n标签: ${room.tags || ""}`,
      contents: this.createImages(
        [biliUrl(room.cover), biliUrl(room.keyframe)].filter(Boolean),
        this.headers,
      ),
      author: this.createAuthor(anchor.uname, biliUrl(anchor.face), null, this.headers),
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
      author: this.createAuthor(info.upper?.name, biliUrl(info.upper?.face), null, this.headers),
      graphics,
    })
  }
}
