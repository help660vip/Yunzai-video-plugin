import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { ParseError, IgnoreError } from "../core/errors.js"
import { http } from "../core/http.js"
import { PathTask } from "../core/model.js"
import { htmlToText } from "./shared.js"

// Public application identifier used by AcFun's unauthenticated mobile API.
const APP_MKEY = "AAHewK3eIAAyMjA2MDMyMjQAAhAAMEP1uwSG3TvhYAAAAO5fOOpIdKsH2h4IGsF6BlVwnGQA6_eLEvGiajzUp4_YthxOPC-hxcOpTk0SPSrxyhbdkmIwsXnF9PgS5ly8eQyjuXlcS7VpWG0QlK0HakVDamteMHNHIui0A8V4tmELqQ=="

export function selectAcfunRepresentation(representations = []) {
  const accepted = new Set(["1080p", "720p", "480p", "360p"])
  return representations.find(item => accepted.has(item.qualityType)) || representations[0]
}

export class AcfunParser extends BaseParser {
  static platform = { name: "acfun", displayName: "猴山" }
  static handlers = [
    {
      keyword: "acfun.cn",
      pattern: /(?:ac=|\/ac)(?<acid>[\d_]+)/,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = { referer: "https://www.acfun.cn/" }
  }

  async parse(match) {
    const acid = String(match.groups.acid)
    if (acid.includes("_")) throw new ParseError("暂不支持 AcFun 多 P 视频")
    let info
    try {
      info = await http.json("https://api-new.app.acfun.cn/rest/app/douga/info", {
        params: { mkey: APP_MKEY, dougaId: acid }, headers: this.headers,
      })
      if (!info?.currentVideoInfo?.playInfos?.length) throw new ParseError("AcFun 视频数据为空")
    } catch {
      info = await this.parseVideoInfo(`https://www.acfun.cn/v/ac${acid}`)
    }
    return this.collect(info, acid)
  }

  collect(info, acid) {
    const duration = Math.floor(Number(info.durationMillis ?? info.currentVideoInfo?.durationMillis ?? 0) / 1000)
    if (duration >= config.parser_duration_maximum) throw new IgnoreError("视频时长超过限制")
    const representations =
      info.currentVideoInfo?.ksPlayJson?.adaptationSet?.[0]?.representation || []
    const representation = selectAcfunRepresentation(representations)
    const playInfo = info.currentVideoInfo?.playInfos?.[0]
    const stream = playInfo?.playUrls?.at(-1) || playInfo?.cdnUrls?.[0]?.url || representation?.url
    if (!stream) throw new ParseError("未找到 AcFun 视频流")
    const videoTask = new PathTask(() =>
      this.downloader.downloadM3u8(stream, {
        fileName: `acfun_${acid}.mp4`,
        headers: this.headers,
        cacheKey: "acfun:" + acid,
      }),
    )
    const video = this.createVideo(videoTask, info.coverUrl, duration, { isDynamicSize: true })
    video.isDynamicSize = true
    return this.result({
      contentId: acid,
      title: info.title,
      text: htmlToText(info.description, "https://www.acfun.cn/"),
      author: this.createAuthor(info.user?.name, info.user?.headUrl, null, this.headers, {
        id: info.user?.id, location: info.user?.ipLocation, cacheKey: "acfun:author:" + info.user?.id,
      }),
      timestamp: Math.floor(Number(info.createTimeMillis || 0) / 1000),
      contents: [video],
      url: `https://www.acfun.cn/v/ac${acid}`,
      stats: this.createStats({
        views: info.viewCount, likes: info.likeCount, comments: info.commentCount,
        collects: info.stowCount, shares: info.shareCount,
        extra: { banana: ["香蕉", info.bananaCount], danmaku: ["弹幕", info.danmakuCount] },
      }),
    })
  }

  async parseVideoInfo(sourceUrl) {
    const url = `${sourceUrl}?quickViewId=videoInfo_new&ajaxpipe=1`
    const html = await http.text(url, { headers: this.headers })
    const matched = /window\.videoInfo =(.*?)<\/script>/.exec(html)
    if (!matched) throw new ParseError("解析 acfun 视频信息失败")
    const raw = matched[1].trim()
    let info
    try {
      info = JSON.parse(raw)
    } catch {
      info = JSON.parse(JSON.parse('"' + raw + '"'))
    }
    if (typeof info.currentVideoInfo?.ksPlayJson === "string") {
      info.currentVideoInfo.ksPlayJson = JSON.parse(info.currentVideoInfo.ksPlayJson)
    }
    return info
  }
}
