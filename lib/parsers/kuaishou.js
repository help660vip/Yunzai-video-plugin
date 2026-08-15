import { BaseParser } from "../core/registry.js"
import { ParseError } from "../core/errors.js"
import { http } from "../core/http.js"
import { IOS_HEADERS, pickUrl, randomChoice } from "../core/utils.js"

export class KuaishouParser extends BaseParser {
  static platform = { name: "kuaishou", displayName: "快手" }
  static handlers = [
    {
      keyword: "v.kuaishou",
      pattern: /v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
    {
      keyword: "kuaishou",
      pattern: /(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
    {
      keyword: "chenzhongtech",
      pattern: /(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parse",
    },
  ]

  constructor() {
    super()
    this.headers = { ...IOS_HEADERS, referer: "https://v.kuaishou.com/" }
  }

  async parse(match) {
    const source = `https://${match[0]}`
    let realUrl = await this.getRedirectUrl(source, this.headers)
    if (!realUrl) throw new ParseError("failed to get location url from url")
    realUrl = realUrl.replace("/fw/long-video/", "/fw/photo/")
    const html = await http.text(realUrl, { headers: this.headers })
    const matched = /window\.INIT_STATE\s*=\s*(.*?)<\/script>/.exec(html)
    if (!matched) throw new ParseError("failed to parse video JSON info from HTML")
    const state = JSON.parse(matched[1].trim())
    const photo = Object.values(state)
      .map(item => item?.photo)
      .find(Boolean)
    if (!photo) throw new ParseError("window.init_state don't contains videos or pics")

    const name = String(photo.userName || "未知用户").replace(/\u3164/g, "").trim()
    const result = this.result({
      contentId: photo.photoId || photo.id || null,
      title: photo.caption,
      author: this.createAuthor(name, photo.headUrl),
      timestamp: Math.floor(Number(photo.timestamp || 0) / 1000),
      contents: [],
    })
    const videoUrl = pickUrl(randomChoice(photo.mainMvUrls || []))
    if (videoUrl) {
      result.video = this.createVideo(
        videoUrl,
        pickUrl(randomChoice(photo.coverUrls || [])),
        Math.floor(Number(photo.duration || 0) / 1000),
      )
    }
    const atlas = photo.ext_params?.atlas || {}
    if (atlas.cdnList?.length && atlas.list?.length) {
      const cdn = randomChoice(atlas.cdnList)?.cdn
      if (cdn) {
        result.contents.push(
          ...this.createImages(atlas.list.map(route => `https://${cdn}/${route}`)),
        )
      }
    }
    return result
  }
}
