import { resultCache } from "./cache.js"
import { scheduleCacheCleanup } from "./cache-lifecycle.js"
import { extractMessageTexts } from "./message.js"
import { isEnabled } from "./group-filter.js"
import { matchUrl } from "./registry.js"
import { reaction } from "./sender.js"
import {
  BLOCKED_CONTENT,
  BLOCKED_CONTENT_MESSAGE,
  isBlockedContent,
  shouldBlockResult,
} from "./safety.js"
import { renderAndSend } from "../render/renderer.js"
import { log } from "./logger.js"
import { config, onConfigChange } from "./config.js"
import { storeLazyResult } from "./lazy.js"
import { claimContent, singleflight } from "./dedup.js"

const COMMAND_PREFIX = /^(?:bm|ym|blogin|开启解析|关闭解析)(?:\s|$)/i

let configRevision = 0
onConfigChange(() => { configRevision++; resultCache.clear() })

export async function handleParserEvent(e) {
  if (!isEnabled(e)) return false
  const texts = await extractMessageTexts(e)
  if (!texts.length || COMMAND_PREFIX.test(texts[0])) return false
  const route = texts.map(text => matchUrl(text)).find(Boolean)
  if (!route) return false

  void scheduleCacheCleanup({ reason: "parse" })
  try {
    const cacheKey = route.cacheKey || route.match[0]
    const revision = configRevision
    const requestKey = revision + ":" + String(route.parser.platform?.name || "unknown") + ":" + cacheKey
    let result = resultCache.get(cacheKey)
    if (isBlockedContent(result)) {
      await e.reply(BLOCKED_CONTENT_MESSAGE)
      await reaction(e, "done")
      return "return"
    }
    if (!result) {
      result = await singleflight(requestKey, async () => {
        const cached = resultCache.get(cacheKey)
        if (cached) return cached
        return route.parser[route.method](route.match, route)
      })
    } else {
      log.debug(`[parser] 命中缓存: ${cacheKey}`)
    }
    if (isBlockedContent(result)) {
      await e.reply(BLOCKED_CONTENT_MESSAGE)
      await reaction(e, "done")
      return "return"
    }
    if (shouldBlockResult(result)) {
      if (revision === configRevision) resultCache.set(cacheKey, BLOCKED_CONTENT)
      await e.reply(BLOCKED_CONTENT_MESSAGE)
      await reaction(e, "done")
      return "return"
    }
    if (!isEnabled(e) || config.parser_disabled_platforms.includes(result.platform?.name)) return false
    log.debug("[parser] 解析结果已通过安全检查", {
      platform: result.platform?.name,
      contentType: result.contentType,
    })
    if (revision === configRevision) resultCache.set(cacheKey, result)
    if (!claimContent(e, result)) {
      log.debug("[parser] duplicate content suppressed within 30s", {
        platform: result.platform?.name,
        contentId: result.contentId,
      })
      return "return"
    }
    await reaction(e, "resolving")
    await renderAndSend(e, result, { sendContents: !config.parser_lazy_download })
    if (config.parser_lazy_download && storeLazyResult(e, result) && config.parser_lazy_download_tip) {
      await e.reply("媒体已暂存，发送 " + config.parser_download_command[0] + " 下载。")
    }
    await reaction(e, "done")
  } catch (error) {
    await reaction(e, "fail")
    throw error
  }
  return "return"
}
