import fs from "node:fs"
import path from "node:path"
import QRCode from "qrcode"

import { resultCache } from "./lib/core/cache.js"
import { scheduleCacheCleanup } from "./lib/core/cache-lifecycle.js"
import { config, onConfigChange } from "./lib/core/config.js"
import { downloader } from "./lib/core/downloader.js"
import { handleParserEvent } from "./lib/core/engine.js"
import { setEnabled } from "./lib/core/group-filter.js"
import {
  claimLazyResult,
  clearLazyResults,
  finishLazyResult,
} from "./lib/core/lazy.js"
import { log } from "./lib/core/logger.js"
import { cacheDir } from "./lib/core/paths.js"
import { enabledPlatforms, getParser } from "./lib/core/registry.js"
import {
  imageSegment,
  reaction,
  recordSegment,
  sendFile,
  renderContents,
} from "./lib/core/sender.js"
import { commandExists, sleep } from "./lib/core/utils.js"
import { hasYtDlp, ytdlp } from "./lib/core/ytdlp.js"
import { BilibiliParser } from "./lib/parsers/bilibili.js"
import { biliApi } from "./lib/parsers/bilibili-api.js"
import { registerBuiltinParsers } from "./lib/parsers/index.js"

await registerBuiltinParsers()

const Plugin = globalThis.plugin
if (!Plugin) throw new Error("nonebot-plugin-parser 必须由 Miao-Yunzai / TRSS-Yunzai 加载")

function commandRules() {
  const rules = [
    { reg: "^开启解析$", fnc: "enableParser", permission: "admin" },
    { reg: "^关闭解析$", fnc: "disableParser", permission: "admin" },
    { reg: "^bm(?:\\s+.*)?$", fnc: "bilibiliMusic" },
    { reg: "^blogin$", fnc: "bilibiliLogin", permission: "master" },
  ]
  if (hasYtDlp) rules.splice(3, 0, { reg: "^ym(?:\\s+.*)?$", fnc: "youtubeMusic" })
  if (config.parser_lazy_download) {
    const commandPattern = config.parser_download_command
      .map(command => command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")
    rules.push({ reg: "^(?:" + commandPattern + ")$", fnc: "lazyDownload" })
  }
  return rules
}

export class ParserMessagePlugin extends Plugin {
  constructor() {
    super({
      name: "链接分享解析",
      dsc: "支持 32 个国内外视频、社区和音乐平台的链接分享解析",
      event: "message",
      priority: 5,
      rule: [],
    })
  }

  async init() {
    const cleanup = await scheduleCacheCleanup({ force: true, reason: "startup" })
    log.info(`[parser] 启动缓存检查完成：清理 ${cleanup.deletedFiles || 0} 个文件`)
    log.info(`[parser] 启用平台: ${enabledPlatforms().join(", ")}`)
    if (!commandExists("ffmpeg")) {
      log.warn("[parser] 未检测到 ffmpeg，音视频合并、转码和 GIF 功能将不可用")
    }
    if (!hasYtDlp) {
      log.warn("[parser] 未检测到 yt-dlp，YouTube、TikTok 和 ym 命令未注册")
    }
  }

  async accept(e) {
    try {
      return await handleParserEvent(e || this.e)
    } catch (error) {
      log.error("[parser] 链接解析失败", error)
      return "return"
    }
  }
}

export class ParserCommandPlugin extends Plugin {
  constructor() {
    super({
      name: "链接解析命令",
      dsc: "解析开关及音频、B站登录命令",
      event: "message",
      priority: 3,
      rule: commandRules(),
    })
    this.stopConfigWatch = onConfigChange(() => {
      this.rule = commandRules()
      resultCache.clear()
      clearLazyResults()
    })
  }

  async enableParser() {
    if (!this.e.isGroup || !this.e.atBot) return false
    setEnabled(this.e, true)
    await this.reply("解析已开启")
  }

  async disableParser() {
    if (!this.e.isGroup || !this.e.atBot) return false
    setEnabled(this.e, false)
    await this.reply("解析已关闭")
  }

  async bilibiliMusic() {
    await reaction(this.e, "resolving")
    try {
      const matched = /(BV[A-Za-z0-9]{10})(?:\s(\d{1,3}))?/.exec(this.e.msg || "")
      if (!matched) {
        await this.reply("请发送正确的 BV 号")
        return
      }
      const bvid = matched[1]
      const pageIndex = Number(matched[2] || 1) - 1
      const parser = getParser(BilibiliParser)
      const { audioUrls } = await parser.extractDownloadStreams({ bvid, pageIndex })
      if (!audioUrls?.length) {
        await this.reply("未找到可下载的音频")
        return
      }
      const audioPath = await downloader.downloadAudio(audioUrls[0], {
        fileName: `${bvid}-${pageIndex}.mp3`,
        headers: parser.headers,
        fallbackUrls: audioUrls.slice(1),
        retryHttpStatuses: BilibiliParser.BILI_RETRYABLE_HTTP_STATUSES,
      })
      await this.reply(await recordSegment(audioPath))
      if (config.parser_need_upload_audio) await sendFile(this.e, audioPath)
      await reaction(this.e, "done")
    } catch (error) {
      await reaction(this.e, "fail")
      throw error
    }
  }

  async youtubeMusic() {
    await reaction(this.e, "resolving")
    try {
      const matched =
        /(?:youtu\.be\/[A-Za-z\d._?%&+\-=/#]+|youtube\.com\/(?:watch|shorts)(?:\/[A-Za-z\d_-]+|\?v=[A-Za-z\d_-]+))/.exec(
          this.e.msg || "",
        )
      if (!matched) {
        await this.reply("请发送正确的油管链接")
        return
      }
      const audioPath = await ytdlp.downloadAudio(`https://${matched[0]}`)
      await this.reply(await recordSegment(audioPath))
      if (config.parser_need_upload_audio) await sendFile(this.e, audioPath)
      await reaction(this.e, "done")
    } catch (error) {
      await reaction(this.e, "fail")
      throw error
    }
  }

  async bilibiliLogin() {
    if (this.e.isGroup) return false
    if (!getParser(BilibiliParser)) throw new Error("B站解析器已被禁用")
    const login = await biliApi.startQrLogin()
    const qrPath = path.join(cacheDir, `bilibili-login-${Date.now()}.png`)
    await fs.promises.writeFile(qrPath, await QRCode.toBuffer(login.url))
    await this.reply(await imageSegment(qrPath))
    let scanTipPending = true
    for (let index = 0; index < 30; index += 1) {
      const state = await biliApi.pollQrLogin(login.key)
      if (state.code === 0) {
        await this.reply("登录成功")
        return
      }
      if (state.code === 86090 && scanTipPending) {
        await this.reply("二维码已扫描, 请确认登录")
        scanTipPending = false
      } else if (state.code === 86038) {
        await this.reply("二维码过期, 请重新生成")
        return
      }
      await sleep(2000)
    }
    await this.reply("二维码登录超时, 请重新生成")
  }

  async lazyDownload() {
    const command = String(this.e?.msg || "").trim()
    if (
      !config.parser_lazy_download ||
      !config.parser_download_command.includes(command)
    ) {
      return false
    }
    const claimed = claimLazyResult(this.e)
    if (claimed.state === "missing") {
      await this.reply("没有等待下载的解析结果")
      return
    }
    if (claimed.state === "expired") {
      await this.reply("暂存内容已过期，请重新发送链接")
      return
    }
    if (claimed.state === "busy") {
      await this.reply("媒体正在下载，请稍候")
      return
    }
    try {
      await reaction(this.e, "resolving")
      await renderContents(this.e, claimed.result)
      finishLazyResult(claimed.key)
      await reaction(this.e, "done")
    } catch (error) {
      finishLazyResult(claimed.key, true)
      await reaction(this.e, "fail")
      throw error
    }
  }
}

export class ParserMaintenancePlugin extends Plugin {
  constructor() {
    super({
      name: "链接解析缓存清理",
      dsc: "每日清理链接解析缓存",
      event: "message",
      priority: 5000,
      rule: [],
      task: {
        name: "链接解析缓存清理",
        cron: "0 0 1 * * *",
        fnc: "cleanCache",
        log: false,
      },
    })
  }

  async cleanCache() {
    const cleanup = await scheduleCacheCleanup({ force: true, reason: "daily" })
    resultCache.clear()
    clearLazyResults()
    log.info(
      `[parser] 缓存维护完成：清理 ${cleanup.deletedFiles || 0} 个文件、` +
      `${cleanup.removedDirectories || 0} 个空目录`,
    )
  }
}
