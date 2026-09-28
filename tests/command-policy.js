import assert from "node:assert/strict"
import { config } from "../lib/core/config.js"
import { Creator } from "../lib/core/creator.js"
import { ParseResult } from "../lib/core/model.js"
import { getParser } from "../lib/core/registry.js"
import { BLOCKED_CONTENT_MESSAGE } from "../lib/core/safety.js"
import { ytdlp } from "../lib/core/ytdlp.js"
import { clearLazyResults, storeLazyResult } from "../lib/core/lazy.js"
import { YouTubeParser } from "../lib/parsers/youtube.js"

globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
const { ParserCommandPlugin } = await import("../index.js?command-policy")
const saved = { ...config }
const command = new ParserCommandPlugin()
const replies = []
const event = { self_id: "bot", user_id: "user", group_id: "group", msg: "xz", reply: async value => replies.push(value) }
command.e = event
command.reply = event.reply
let downloads = 0
const restricted = new ParseResult({ platform: { name: "youtube", displayName: "YouTube" },
  title: "must-not-leak", safety: { ageLimit: 18 }, content: [Creator.video(() => { downloads++; return "media" })] })
const parser = getParser(YouTubeParser)
const originalParse = parser.parseVideo
const originalDownload = ytdlp.downloadAudio
try {
  config.parser_r18_filter_enabled = true
  config.parser_r18_platforms = ["twitter", "youtube", "tiktok"]
  config.parser_lazy_download = true
  config.parser_download_command = ["xz"]
  config.parser_blacklist_users = []
  config.parser_disabled_platforms = []
  config.parser_group_blacklist_enabled = true
  storeLazyResult(event, restricted)
  await command.lazyDownload()
  assert.deepEqual(replies, [BLOCKED_CONTENT_MESSAGE])
  assert.equal(downloads, 0)

  replies.length = 0
  storeLazyResult(event, restricted)
  config.parser_disabled_platforms = ["youtube"]
  await command.lazyDownload()
  assert.equal(replies.length, 0)
  assert.equal(downloads, 0)
  config.parser_disabled_platforms = []

  parser.parseVideo = async () => restricted
  ytdlp.downloadAudio = async () => { downloads++; return "media" }
  event.msg = "ym https://youtu.be/abcdefghijk"
  await command.youtubeMusic()
  assert.deepEqual(replies, [BLOCKED_CONTENT_MESSAGE])
  assert.equal(downloads, 0)

  config.parser_blacklist_users = ["user"]
  replies.length = 0
  await command.youtubeMusic()
  assert.equal(downloads, 0)
  assert.equal(replies.length, 0)
  console.log("✓ 懒下载与音频命令重检安全策略、平台开关和用户名单")
} finally {
  command.stopConfigWatch()
  Object.assign(config, saved)
  clearLazyResults()
  parser.parseVideo = originalParse
  ytdlp.downloadAudio = originalDownload
  delete globalThis.plugin
}
