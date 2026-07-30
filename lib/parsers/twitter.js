import { BaseParser } from "../core/registry.js"
import { http } from "../core/http.js"

export class TwitterParser extends BaseParser {
  static platform = { name: "twitter", displayName: "小蓝鸟" }
  static handlers = [
    {
      keyword: "x.com",
      pattern: /x\.com\/[0-9-a-zA-Z_]{1,20}\/status\/([0-9]+)/,
      method: "parse",
    },
  ]

  async parse(match) {
    const url = `https://${match[0]}`
    const data = await http.json(url.replace("x.com", "api.vxtwitter.com"), {
      headers: this.headers,
    })
    return this.collect(data)
  }

  collect(data) {
    const title = typeof data.article === "object" ? data.article?.title : data.article
    const result = this.result({
      author: this.createAuthor(data.user_name, data.user_profile_image_url),
      title,
      text: data.text,
      timestamp: data.date_epoch,
    })
    for (const media of data.media_extended || []) {
      if (media.type === "video") {
        result.contents.push(
          this.createVideo(
            media.url,
            media.thumbnail_url,
            media.duration_millis ? media.duration_millis / 1000 : null,
          ),
        )
      } else if (media.type === "gif") {
        result.contents.push(
          this.createGif(
            media.url,
            media.thumbnail_url,
            media.duration_millis ? media.duration_millis / 1000 : null,
          ),
        )
      } else if (media.type === "image") {
        result.contents.push(this.createImage(`${media.url}?format=jpg&name=orig`))
      }
    }
    if (data.qrt) result.repost = this.collect(data.qrt)
    return result
  }
}
