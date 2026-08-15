import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { ParseError, IgnoreError } from "../core/errors.js"
import { http } from "../core/http.js"
import { PathTask } from "../core/model.js"

export function selectAcfunRepresentation(representations = []) {
  const accepted = new Set(["1080p", "720p", "480p", "360p"])
  return representations.find(item => accepted.has(item.qualityType)) || representations[0]
}

export class AcfunParser extends BaseParser {
  static platform = { name: "acfun", displayName: "猴山" }
  static handlers = [
    {
      keyword: "acfun.cn",
      pattern: /(?:ac=|\/ac)(?<acid>\d+)/,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = { referer: "https://www.acfun.cn/" }
  }

  async parse(match) {
    const acid = Number(match.groups.acid)
    const info = await this.parseVideoInfo(`https://www.acfun.cn/v/ac${acid}`)
    const duration = Math.floor(Number(info.currentVideoInfo?.durationMillis || 0) / 1000)
    if (duration >= config.parser_duration_maximum) throw new IgnoreError("视频时长超过限制")
    const representations =
      info.currentVideoInfo?.ksPlayJson?.adaptationSet?.[0]?.representation || []
    const representation = selectAcfunRepresentation(representations)
    if (!representation?.url) throw new ParseError("未找到 AcFun 视频流")
    const videoTask = new PathTask(() =>
      this.downloader.downloadM3u8(representation.url, {
        fileName: `acfun_${acid}.mp4`,
      }),
    )
    return this.result({
      contentId: acid,
      title: info.title,
      text: info.description,
      author: this.createAuthor(info.user?.name, info.user?.headUrl),
      timestamp: Math.floor(Number(info.createTimeMillis || 0) / 1000),
      contents: [this.createVideo(videoTask, info.coverUrl)],
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
