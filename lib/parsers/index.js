import { registerParser } from "../core/registry.js"
import { hasYtDlp } from "../core/ytdlp.js"

import { AcfunParser } from "./acfun.js"
import { BilibiliParser } from "./bilibili.js"
import { DouyinParser } from "./douyin.js"
import { KuaishouParser } from "./kuaishou.js"
import { NgaParser } from "./nga.js"
import { TwitterParser } from "./twitter.js"
import { WeiboParser } from "./weibo.js"
import { XiaohongshuParser } from "./xiaohongshu.js"

export function registerBuiltinParsers() {
  for (const ParserClass of [
    BilibiliParser,
    DouyinParser,
    KuaishouParser,
    WeiboParser,
    XiaohongshuParser,
    TwitterParser,
    AcfunParser,
    NgaParser,
  ]) {
    registerParser(ParserClass)
  }
  if (hasYtDlp) {
    return Promise.all([
      import("./youtube.js").then(({ YouTubeParser }) => registerParser(YouTubeParser)),
      import("./tiktok.js").then(({ TikTokParser }) => registerParser(TikTokParser)),
    ])
  }
  return Promise.resolve()
}
