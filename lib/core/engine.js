import { resultCache } from "./cache.js"
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
import { config } from "./config.js"
import { storeLazyResult } from "./lazy.js"

const COMMAND_PREFIX = /^(?:bm|ym|blogin|开启解析|关闭解析)(?:\s|$)/i

export async function handleParserEvent(e) {
  if (!isEnabled(e)) return false
  const texts = await extractMessageTexts(e)
  if (!texts.length || COMMAND_PREFIX.test(texts[0])) return false
  const route = texts.map(text => matchUrl(text)).find(Boolean)
  if (!route) return false

  await reaction(e, "resolving")
  try {
    const cacheKey = route.cacheKey || route.match[0]
    let result = resultCache.get(cacheKey)
    if (isBlockedContent(result)) {
      await e.reply(BLOCKED_CONTENT_MESSAGE)
      await reaction(e, "done")
      return "return"
    }
    if (!result) {
      result = await route.parser[route.method](route.match, route)
    } else {
      log.debug(`[parser] 命中缓存: ${cacheKey}`)
    }
    if (shouldBlockResult(result)) {
      resultCache.set(cacheKey, BLOCKED_CONTENT)
      await e.reply(BLOCKED_CONTENT_MESSAGE)
      await reaction(e, "done")
      return "return"
    }
    log.debug("[parser] 解析结果已通过安全检查", {
      platform: result.platform?.name,
      contentType: result.contentType,
    })
    await renderAndSend(e, result, { sendContents: !config.parser_lazy_download })
    if (config.parser_lazy_download && storeLazyResult(e, result) && config.parser_lazy_download_tip) {
      await e.reply("媒体已暂存，发送 " + config.parser_download_command[0] + " 下载。")
    }
    resultCache.set(cacheKey, result)
    await reaction(e, "done")
  } catch (error) {
    await reaction(e, "fail")
    throw error
  }
  return "return"
}
