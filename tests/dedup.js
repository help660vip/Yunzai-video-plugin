import assert from "node:assert/strict"

import { resultCache } from "../lib/core/cache.js"
import { config } from "../lib/core/config.js"
import {
  DEDUP_TTL_MS,
  claimContent,
  clearDedupForTests,
  contentFingerprint,
  dedupScope,
  dedupStateForTests,
  singleflight,
} from "../lib/core/dedup.js"
import { handleParserEvent } from "../lib/core/engine.js"
import { groupKey, groupSet } from "../lib/core/group-filter.js"
import { GraphicContent, ParseResult, PathTask } from "../lib/core/model.js"
import { BaseParser, registerParser } from "../lib/core/registry.js"
import { BLOCKED_CONTENT_MESSAGE } from "../lib/core/safety.js"

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function result(values = {}) {
  return new ParseResult({
    platform: { name: "fixture", displayName: "Fixture" },
    title: "stable title",
    text: "stable text",
    ...values,
  })
}

test("ParseResult 接受可选 contentId 并统一为字符串", () => {
  assert.equal(result({ contentId: 123 }).contentId, "123")
  assert.equal(result().contentId, null)
})

test("contentId 优先生成稳定内容指纹并按平台隔离", () => {
  const first = result({ contentId: "post-1", title: "old title" })
  const second = result({ contentId: "post-1", title: "new title" })
  const another = new ParseResult({
    platform: { name: "another", displayName: "Another" },
    contentId: "post-1",
  })
  assert.equal(contentFingerprint(first), contentFingerprint(second))
  assert.notEqual(contentFingerprint(first), contentFingerprint(another))
})

test("无 contentId 时规范化 URL 参数顺序并忽略常见跟踪参数", () => {
  const first = result({
    url: "https://example.invalid/post/1?b=2&a=1&utm_source=share",
    title: "old title",
  })
  const second = result({
    url: "https://example.invalid/post/1?a=1&b=2",
    title: "new title",
  })
  assert.equal(contentFingerprint(first), contentFingerprint(second))
})

test("无 contentId 时结构顺序与 PathTask factory 不影响稳定指纹", () => {
  const firstTask = new PathTask(async () => "first", "media", {
    url: "https://media.invalid/a.jpg",
    cacheKey: "media-a",
  })
  const secondTask = new PathTask(async () => "second", "media", {
    url: "https://media.invalid/a.jpg",
    cacheKey: "media-a",
  })
  const first = result({
    extra: { beta: 2, alpha: 1 },
    contents: [new GraphicContent(firstTask)],
  })
  const second = result({
    extra: { alpha: 1, beta: 2 },
    contents: [new GraphicContent(secondTask)],
  })
  assert.equal(contentFingerprint(first), contentFingerprint(second))
  assert.notEqual(
    contentFingerprint(first),
    contentFingerprint(result({ title: "different" })),
  )
})

test("去重作用域为同 bot 同群，私聊则按用户", () => {
  assert.equal(
    dedupScope({ self_id: 1, group_id: 10, user_id: 100 }),
    dedupScope({ self_id: 1, group_id: 10, user_id: 200 }),
  )
  assert.notEqual(
    dedupScope({ self_id: 1, group_id: 10, user_id: 100 }),
    dedupScope({ self_id: 2, group_id: 10, user_id: 100 }),
  )
  assert.notEqual(
    dedupScope({ self_id: 1, group_id: 10, user_id: 100 }),
    dedupScope({ self_id: 1, group_id: 11, user_id: 100 }),
  )
  assert.equal(
    dedupScope({ self_id: 1, user_id: 100 }),
    dedupScope({ self_id: 1, user_id: 100 }),
  )
  assert.notEqual(
    dedupScope({ self_id: 1, user_id: 100 }),
    dedupScope({ self_id: 1, user_id: 200 }),
  )
})

test("claim 在 30 秒 TTL 内静默拒绝，边界到期后重新允许", () => {
  clearDedupForTests()
  const content = result({ contentId: "ttl" })
  const first = { self_id: 1, group_id: 10, user_id: 100 }
  const sameGroup = { self_id: 1, group_id: 10, user_id: 200 }
  const anotherGroup = { self_id: 1, group_id: 11, user_id: 100 }
  assert.equal(claimContent(first, content, 1_000), true)
  assert.equal(claimContent(sameGroup, content, 1_000 + DEDUP_TTL_MS - 1), false)
  assert.equal(claimContent(anotherGroup, content, 1_001), true)
  assert.equal(claimContent(sameGroup, content, 1_000 + DEDUP_TTL_MS), true)
})

test("去重开关与窗口从热配置实时读取", () => {
  const previous = {
    enabled: config.parser_dedup_enabled,
    window: config.parser_dedup_window_seconds,
  }
  const event = { self_id: 1, group_id: 2, user_id: 3 }
  const value = result({ contentId: "hot-config" })
  try {
    clearDedupForTests()
    config.parser_dedup_enabled = false
    assert.equal(claimContent(event, value, 1000), true)
    assert.equal(claimContent(event, value, 1001), true)

    config.parser_dedup_enabled = true
    config.parser_dedup_window_seconds = 1
    assert.equal(claimContent(event, value, 2000), true)
    assert.equal(claimContent(event, value, 2999), false)
    assert.equal(claimContent(event, value, 3000), true)
  } finally {
    config.parser_dedup_enabled = previous.enabled
    config.parser_dedup_window_seconds = previous.window
    clearDedupForTests()
  }
})

test("singleflight 共享并发结果并在完成后释放", async () => {
  clearDedupForTests()
  let starts = 0
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const factory = async () => {
    starts += 1
    await gate
    return { ok: true }
  }
  const first = singleflight("request", factory)
  const second = singleflight("request", factory)
  assert.equal(first, second)
  assert.equal(starts, 0)
  await Promise.resolve()
  assert.equal(starts, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.equal(dedupStateForTests().flights, 0)
  await singleflight("request", async () => {
    starts += 1
    return { ok: true }
  })
  assert.equal(starts, 2)
})

let engineParseCount = 0
let enginePathCount = 0

class EngineDedupParser extends BaseParser {
  static platform = { name: "engine-dedup", displayName: "Engine Dedup" }
  static handlers = [
    {
      keyword: "dedup.invalid",
      pattern: /dedup\.invalid\/(?<id>\d+)/,
      method: "parse",
    },
  ]

  async parse(match) {
    engineParseCount += 1
    await Promise.resolve()
    const task = new PathTask(async () => {
      enginePathCount += 1
      return "fixture.jpg"
    }, "engine-dedup-media")
    return this.result({
      contentId: match.groups.id,
      title: "dedup " + match.groups.id,
      text: "content",
      contents: [new GraphicContent(task)],
    })
  }
}

let unsafeParseCount = 0
let unsafePathCount = 0

class EngineUnsafeParser extends BaseParser {
  static platform = { name: "twitter", displayName: "X" }
  static handlers = [
    {
      keyword: "unsafe.invalid",
      pattern: /unsafe\.invalid\/(?<id>\d+)/,
      method: "parse",
    },
  ]

  async parse(match) {
    unsafeParseCount += 1
    const task = new PathTask(async () => {
      unsafePathCount += 1
      return "unsafe.jpg"
    }, "unsafe-media")
    return this.result({
      contentId: match.groups.id,
      safety: { sensitive: true },
      contents: [new GraphicContent(task)],
    })
  }
}

registerParser(EngineDedupParser)
registerParser(EngineUnsafeParser)

function parserEvent(url, values = {}) {
  const replies = []
  return {
    self_id: 90001,
    user_id: 10001,
    group_id: 70001,
    isGroup: true,
    message: [{ type: "text", text: url }],
    reply: async value => replies.push(value),
    replies,
    ...values,
  }
}

test("引擎并发同请求只解析一次，同 bot 同群重复不渲染、不下载、不发送", async () => {
  const previous = {
    renderType: config.parser_render_type,
    lazy: config.parser_lazy_download,
    base64: config.parser_use_base64,
    forward: config.parser_need_forward_contents,
    groupBlacklist: config.parser_group_blacklist_enabled,
  }
  const first = parserEvent("https://dedup.invalid/101", { user_id: 1 })
  const second = parserEvent("https://dedup.invalid/101", { user_id: 2 })
  const repeated = parserEvent("https://dedup.invalid/101", { user_id: 3 })
  const anotherGroup = parserEvent("https://dedup.invalid/101", {
    user_id: 4,
    group_id: 70002,
  })
  try {
    resultCache.clear()
    clearDedupForTests()
    engineParseCount = 0
    enginePathCount = 0
    config.parser_render_type = "default"
    config.parser_lazy_download = false
    config.parser_use_base64 = false
    config.parser_need_forward_contents = false
    config.parser_group_blacklist_enabled = true
    groupSet.delete(groupKey(first))
    groupSet.delete(groupKey(anotherGroup))

    await Promise.all([handleParserEvent(first), handleParserEvent(second)])
    assert.equal(engineParseCount, 1)
    assert.equal(enginePathCount, 1)
    assert.equal(first.replies.length + second.replies.length, 2)
    assert.ok(first.replies.length === 0 || second.replies.length === 0)

    await handleParserEvent(repeated)
    assert.equal(repeated.replies.length, 0)
    assert.equal(engineParseCount, 1)
    assert.equal(enginePathCount, 1)

    await handleParserEvent(anotherGroup)
    assert.equal(anotherGroup.replies.length, 2)
    assert.equal(engineParseCount, 1)
    assert.equal(enginePathCount, 1)
  } finally {
    config.parser_render_type = previous.renderType
    config.parser_lazy_download = previous.lazy
    config.parser_use_base64 = previous.base64
    config.parser_need_forward_contents = previous.forward
    config.parser_group_blacklist_enabled = previous.groupBlacklist
    resultCache.clear()
    clearDedupForTests()
  }
})

test("R18 安全检查先于 claim，拦截结果不启动媒体任务", async () => {
  const previous = {
    enabled: config.parser_r18_filter_enabled,
    platforms: config.parser_r18_platforms,
    blockX: config.parser_block_x_sensitive,
    groupBlacklist: config.parser_group_blacklist_enabled,
  }
  const event = parserEvent("https://unsafe.invalid/201")
  try {
    resultCache.clear()
    clearDedupForTests()
    unsafeParseCount = 0
    unsafePathCount = 0
    config.parser_r18_filter_enabled = true
    config.parser_r18_platforms = ["twitter", "youtube", "tiktok"]
    config.parser_block_x_sensitive = true
    config.parser_group_blacklist_enabled = true
    groupSet.delete(groupKey(event))

    assert.equal(await handleParserEvent(event), "return")
    assert.equal(unsafeParseCount, 1)
    assert.equal(unsafePathCount, 0)
    assert.deepEqual(event.replies, [BLOCKED_CONTENT_MESSAGE])
    assert.equal(dedupStateForTests().claims, 0)
  } finally {
    config.parser_r18_filter_enabled = previous.enabled
    config.parser_r18_platforms = previous.platforms
    config.parser_block_x_sensitive = previous.blockX
    config.parser_group_blacklist_enabled = previous.groupBlacklist
    resultCache.clear()
    clearDedupForTests()
  }
})

let failures = 0
for (const item of tests) {
  try {
    await item.fn()
    console.log("✓ " + item.name)
  } catch (error) {
    failures += 1
    console.error("✗ " + item.name)
    console.error(error)
  }
}

console.log("\n" + (tests.length - failures) + "/" + tests.length + " tests passed")
if (failures) process.exitCode = 1
