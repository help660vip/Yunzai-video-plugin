import { config } from "../core/config.js"
import { http } from "../core/http.js"
import { log } from "../core/logger.js"
import { normalizeMediaRanges } from "../core/ffmpeg.js"

export class BilibiliSponsorBlock {
  constructor(duration, segments = []) {
    this.duration = Number(duration) || 0
    this.segments = segments
    this.cutRanges = normalizeMediaRanges(segments.filter(item => item.actionType === "skip").map(item => [item.start, item.end]), this.duration)
    this.muteRanges = normalizeMediaRanges(segments.filter(item => item.actionType === "mute").map(item => [item.start, item.end]), this.duration)
  }

  get coversEntireVideo() { return this.cutRanges.length === 1 && this.cutRanges[0][0] === 0 && this.cutRanges[0][1] === this.duration }
  get removedDuration() { return this.cutRanges.reduce((sum, [start, end]) => sum + end - start, 0) }
  get outputDuration() { return this.duration - this.removedDuration }
  get isFullVideoAd() {
    const categories = new Set(["sponsor", "selfpromo"])
    if (this.segments.some(item => item.actionType === "full" && categories.has(item.category))) return true
    const ranges = normalizeMediaRanges(this.segments.filter(item => item.actionType === "skip" && categories.has(item.category)).map(item => [item.start, item.end]), this.duration)
    return ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === this.duration
  }

  static async query(bvid, cid, duration, { client = http, apiBase = config.parser_bsb_api_base, categories = config.parser_bsb_categories || [] } = {}) {
    if (!apiBase || !categories.length || !cid) return new this(duration)
    try {
      const target = new URL("api/skipSegments", String(apiBase).replace(/\/?$/, "/"))
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return new this(duration)
      const allowed = new Set(categories.map(item => String(item).toLowerCase()))
      target.searchParams.set("videoID", bvid)
      target.searchParams.set("cid", cid)
      target.searchParams.set("categories", JSON.stringify([...allowed]))
      target.searchParams.set("actionTypes", JSON.stringify(["skip", "mute", "full"]))
      const response = await client.request(target, { timeout: 10000 })
      if (response.status !== 200) return new this(duration)
      const data = await response.json()
      const segments = []
      for (const row of Array.isArray(data) ? data : []) {
        if (!row || !Array.isArray(row.segment) || !row.segment.length || String(row.cid) !== String(cid)) continue
        const category = typeof row.category === "string" ? row.category.toLowerCase() : ""
        const actionType = typeof row.actionType === "string" ? row.actionType.toLowerCase() : ""
        if (!allowed.has(category) || !["skip", "mute", "full"].includes(actionType)) continue
        segments.push({ start: row.segment[0], end: row.segment[1] ?? NaN, category, actionType, cid })
      }
      return new this(duration, segments)
    } catch {
      log.warn("[parser] B站空降标注暂不可用，使用原始时间轴")
      return new this(duration)
    }
  }
}
