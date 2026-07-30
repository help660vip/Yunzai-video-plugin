import { resultCache } from "./cache.js"
import { extractMessageText } from "./message.js"
import { isEnabled } from "./group-filter.js"
import { matchUrl } from "./registry.js"
import { reaction } from "./sender.js"
import { renderAndSend } from "../render/renderer.js"
import { log } from "./logger.js"

const COMMAND_PREFIX = /^(?:bm|ym|blogin|开启解析|关闭解析)(?:\s|$)/i

export async function handleParserEvent(e) {
  if (!isEnabled(e)) return false
  const text = extractMessageText(e)
  if (!text || COMMAND_PREFIX.test(text)) return false
  const route = matchUrl(text)
  if (!route) return false

  await reaction(e, "resolving")
  try {
    const cacheKey = route.match[0]
    let result = resultCache.get(cacheKey)
    if (!result) {
      result = await route.parser[route.method](route.match, route)
      log.debug("[parser] 解析结果", result)
    } else {
      log.debug(`[parser] 命中缓存: ${cacheKey}`)
    }
    await renderAndSend(e, result)
    resultCache.set(cacheKey, result)
    await reaction(e, "done")
  } catch (error) {
    await reaction(e, "fail")
    throw error
  }
  return "return"
}
