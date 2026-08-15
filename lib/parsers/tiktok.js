import { BaseParser } from "../core/registry.js"
import { PathTask } from "../core/model.js"
import { ytdlp } from "../core/ytdlp.js"

export class TikTokParser extends BaseParser {
  static platform = { name: "tiktok", displayName: "TikTok" }
  static handlers = [
    {
      keyword: "tiktok",
      pattern: /(?<prefix>www|vt|vm)\.tiktok\.com\/[A-Za-z0-9._?%&+\-=/#@]*/,
      method: "parse",
    },
  ]

  async parse(match) {
    let url = `https://${match[0]}`
    if (["vt", "vm"].includes(match.groups.prefix)) url = await this.getRedirectUrl(url)
    const info = await ytdlp.extractInfo(url)
    const video = this.createVideo(
      new PathTask(() => ytdlp.downloadVideo(url), `tiktok:${url}`),
      info.thumbnail,
      info.duration,
    )
    return this.result({
      contentId: info.id,
      title: info.title,
      text: info.description,
      author: this.createAuthor(info.channel),
      contents: [video],
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
  }
}
