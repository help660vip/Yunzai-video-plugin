import { BaseParser } from "../core/registry.js"
import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { PathTask } from "../core/model.js"
import { ytdlp, writeNetscapeCookies } from "../core/ytdlp.js"

export class YouTubeParser extends BaseParser {
  static platform = { name: "youtube", displayName: "油管" }
  static handlers = [
    {
      keyword: "youtu",
      pattern: /youtu\.be\/[A-Za-z\d._?%&+\-=/#]+/,
      method: "parseMatch",
    },
    {
      keyword: "youtube",
      pattern: /youtube\.com\/(?:watch|shorts)(?:\/[A-Za-z\d_-]+|\?v=[A-Za-z\d_-]+)/,
      method: "parseMatch",
    },
  ]

  cookieFile() {
    return config.parser_ytb_ck
      ? writeNetscapeCookies(config.parser_ytb_ck, "ytb_cookies.txt", "youtube.com")
      : null
  }

  parseMatch(match) {
    return this.parseVideo(`https://${match[0]}`)
  }

  async parseVideo(url) {
    const cookiesFile = this.cookieFile()
    const info = await ytdlp.extractInfo(url, cookiesFile)
    const author = await this.fetchAuthor(info.channelId)
    const result = this.result({
      contentId: info.id,
      author,
      title: info.title,
      text: info.description,
      timestamp: info.timestamp,
      url: info.webpageUrl || null,
      embedUrl: info.webpageUrl || null,
      safety: {
        ageLimit: info.ageLimit,
        rating: info.ageLimit >= 18 ? "adult" : "unknown",
      },
      extra: {
        age_limit: info.ageLimit,
        availability: info.availability,
        tags: [...(info.tags || []), ...(info.categories || [])],
      },
    })
    if (info.duration <= config.parser_duration_maximum) {
      result.video = this.createVideo(
        new PathTask(() => ytdlp.downloadVideo(url, cookiesFile), `youtube:${url}`),
        info.thumbnail,
        info.duration,
      )
    } else if (info.thumbnail) {
      result.contents.push(...this.createImages([info.thumbnail]))
    }
    return result
  }

  async fetchAuthor(channelId) {
    const payload = {
      context: {
        client: {
          hl: "zh-HK",
          gl: "US",
          deviceMake: "Apple",
          deviceModel: "",
          clientName: "WEB",
          clientVersion: "2.20251002.00.00",
          osName: "Macintosh",
          osVersion: "10_15_7",
        },
        user: { lockedSafetyMode: false },
        request: {
          useSsl: true,
          internalExperimentFlags: [],
          consistencyTokenJars: [],
        },
      },
      browseId: channelId,
    }
    const data = await http.json(
      "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
      { method: "POST", headers: this.headers, body: payload },
    )
    const metadata = data.metadata?.channelMetadataRenderer || {}
    return this.createAuthor(
      metadata.title || "",
      metadata.avatar?.thumbnails?.[0]?.url,
      metadata.description,
    )
  }
}
