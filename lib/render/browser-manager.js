import crypto from "node:crypto"
import { log } from "../core/logger.js"
import { discoverHostBrowsers } from "./host-browser.js"
import { discoverBrowserCandidates, resolvePuppeteerModules, inspectBrowserExecutable } from "./browser-discovery.js"

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const DEFAULT_LIMITS = { candidateMs: 8000, totalMs: 25000, pageMs: 45000, maxAttempts: 6, backoffMs: 30000, discoveryTtlMs: 300000 }

export function safeRenderMessage(error) {
  return String(error?.message || error || "unknown error")
    .replace(/(?:https?|wss?):\/\/[^\s)\]"']+/gi, "[endpoint]")
    .replace(/((?:cookie|token|authorization|password|secret)["']?\s*[=:]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[a-z\d._~+\/=-]+/gi, "$1 [redacted]")
    .slice(0, 700)
}

export function classifyBrowserError(error) {
  const text = String(error?.message || error || "")
  if (error?.code === "RENDER_PROTOCOL") return "protocol"
  if (error?.code === "RENDER_CONNECTION") return "connection"
  if (error?.code === "RENDER_PAGE") return "page"
  if (error?.code === "RENDER_TIMEOUT" || /timed?\s*out|timeout/i.test(text)) return "timeout"
  if (/EACCES|EPERM|permission|not[- ]executable|不可执行/i.test(text)) return "permission"
  if (/exec format|wrong architecture|ELFCLASS|architecture|架构/i.test(text)) return "architecture"
  if (/shared librar|cannot open shared object|\.so(?:[.\s:]|$)/i.test(text)) return "shared-library"
  if (/sandbox|zygote|running as root/i.test(text)) return "sandbox"
  if (/ENOENT|could not find|not[- ]found|not installed|缺少|不存在/i.test(text)) return "missing"
  if (/ECONNREFUSED|ECONNRESET|websocket|connect/i.test(text)) return "connection"
  if (/protocol|target closed|session closed/i.test(text)) return "protocol"
  return "launch"
}

function renderError(message, code = "RENDER_ENVIRONMENT") {
  const error = new Error(safeRenderMessage(message))
  error.code = code
  return error
}

// Keep cleanup attached even when a launch/newPage resolves after its deadline.
function deadline(promise, ms, label, lateCleanup) {
  let timer, expired = false
  const work = Promise.resolve(promise)
  work.then(value => { if (expired) void Promise.resolve(lateCleanup?.(value)).catch(() => {}) }, () => {})
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(renderError(label + "超时", "RENDER_TIMEOUT")) }, Math.max(1, ms))
  })]).finally(() => clearTimeout(timer))
}

function connected(browser) {
  try {
    if (typeof browser?.isConnected === "function") return browser.isConnected()
    return browser?.connected !== false && typeof browser?.newPage === "function"
  } catch { return false }
}

async function closeResource(value, method = "close") {
  try { if (typeof value?.[method] === "function") await deadline(value[method](), 1500, "资源释放") } catch {}
}

export function createBrowserManager({
  discoverHosts = discoverHostBrowsers,
  discoverCandidates = discoverBrowserCandidates,
  resolveModules = resolvePuppeteerModules,
  inspectExecutable = inspectBrowserExecutable,
  env = process.env,
  logger = log,
  limits: overrides = {},
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  let standalone = null, initializing = null, generation = 0, discovery = null, discoveryExpires = 0
  let validated = new WeakMap(), hostFailures = new WeakMap()
  const owned = new Set(), leases = new Set(), failures = new Map(), messages = new Map()

  function report(key, message, level = "debug") {
    const now = Date.now()
    if ((messages.get(key) || 0) > now) return
    messages.set(key, now + limits.backoffMs)
    if (messages.size > 100) messages.delete(messages.keys().next().value)
    logger[level]?.("[parser] " + safeRenderMessage(message))
  }

  async function dispose(entry) {
    if (!entry || entry.disposed || entry.owner === "borrowed") return
    entry.disposed = true
    owned.delete(entry)
    await closeResource(entry.browser, entry.owner === "connected" ? "disconnect" : "close")
  }

  async function lease(entry, ms) {
    let context = null, page = null, closed = false
    const until = Date.now() + ms
    const remaining = () => Math.max(1, until - Date.now())
    const release = async () => {
      if (closed) return
      closed = true
      leases.delete(release)
      await closeResource(page)
      await closeResource(context)
      entry.active = Math.max(0, (entry.active || 0) - 1)
      if (entry.retired && !entry.active) await dispose(entry)
    }
    entry.active = (entry.active || 0) + 1
    leases.add(release)
    try {
      const factory = entry.browser.createBrowserContext || entry.browser.createIncognitoBrowserContext
      if (typeof factory === "function") {
        context = await deadline(Promise.resolve().then(() => factory.call(entry.browser)), remaining(), "创建独立页面上下文", value => closeResource(value))
        if (closed) { await closeResource(context); throw renderError("页面创建已取消") }
      }
      const provider = context || entry.browser
      page = await deadline(Promise.resolve().then(() => provider.newPage()), remaining(), "创建渲染页面", value => closeResource(value))
      if (closed) { await closeResource(page); throw renderError("页面创建已取消") }
      for (const method of ["goto", "setContent", "setViewport", "setJavaScriptEnabled", "setRequestInterception", "on", "evaluate", "screenshot", "$", "$eval", "viewport", "close"]) {
        if (typeof page?.[method] !== "function") throw renderError("浏览器页面缺少能力: " + method, "RENDER_PROTOCOL")
      }
      page.setDefaultTimeout?.(limits.pageMs)
      page.setDefaultNavigationTimeout?.(limits.pageMs)
      return { page, release }
    } catch (error) { await release(); throw error }
  }

  async function validate(entry, ms) {
    if (!connected(entry.browser)) throw renderError("浏览器连接已断开", "RENDER_CONNECTION")
    let pending = validated.get(entry.browser)
    if (!pending) {
      pending = (async () => {
        const until = Date.now() + ms
        const { page, release } = await lease(entry, ms)
        try {
          await deadline((async () => {
            await page.setJavaScriptEnabled(false)
            await page.setViewport({ width: 32, height: 32, deviceScaleFactor: 1 })
            await page.setContent('<!doctype html><meta charset="utf-8"><div style="width:32px;height:32px">测试</div>', { waitUntil: "domcontentloaded", timeout: ms })
            if (!await page.evaluate(() => Boolean(document.body && document.body.getBoundingClientRect().width))) throw renderError("本地页面布局验证失败")
            const png = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 32, height: 32 } }))
            if (!png.subarray(0, 8).equals(PNG_HEADER)) throw renderError("本地截图协议验证失败", "RENDER_PROTOCOL")
          })(), Math.max(1, until - Date.now()), "本地截图能力验证")
          let version = "unknown"
          try {
            const value = await deadline(Promise.resolve().then(() => entry.browser.version?.()), Math.min(ms, 1000), "浏览器版本查询")
            version = /(?:HeadlessChrome|Chrome|Chromium|Firefox)\/[\w.-]+/.exec(String(value || ""))?.[0] || "unknown"
          } catch {}
          entry.version = version
          report("ready:" + entry.source + ":" + version, "渲染使用" + (entry.owner === "borrowed" ? "宿主" : "独立") + "浏览器；来源=" + entry.source + "；浏览器=" + version + "; Puppeteer=" + (entry.moduleVersion || "host"), "info")
        } finally { await release() }
      })()
      validated.set(entry.browser, pending)
      pending.catch(() => { if (validated.get(entry.browser) === pending) validated.delete(entry.browser) })
    }
    await deadline(pending, ms + 1600, "浏览器验证")
    return entry
  }

  function explicitChoice() {
    const values = [
      ["executablePath", env.PUPPETEER_EXECUTABLE_PATH],
      ["browserWSEndpoint", env.PUPPETEER_BROWSER_WS_ENDPOINT],
      ["browserURL", env.PUPPETEER_BROWSER_URL],
    ].filter(([, value]) => typeof value === "string" && value.trim()).map(([kind, value]) => ({ kind, value: value.trim() }))
    if (values.length > 1) throw renderError("显式浏览器配置冲突；路径、WebSocket 端点、HTTP 调试入口只能设置一项")
    if (values[0] && values[0].kind !== "executablePath") {
      try {
        const parsed = new URL(values[0].value)
        if (!(values[0].kind === "browserURL" ? ["http:", "https:"] : ["ws:", "wss:"]).includes(parsed.protocol)) throw new Error()
      } catch { throw renderError("显式浏览器连接配置无效") }
    }
    return values[0] || null
  }

  async function discover() {
    if (!discovery || discoveryExpires <= Date.now()) {
      discoveryExpires = Date.now() + limits.discoveryTtlMs
      const current = Promise.resolve().then(() => discoverCandidates({ env }))
      discovery = current
      current.catch(() => { if (discovery === current) discovery = null })
    }
    return discovery
  }

  async function initialize(choice, until, allowance) {
    let candidates, diagnostics = [], modules = []
    const remaining = () => Math.max(1, until - Date.now())
    if (choice) {
      if (choice.kind === "executablePath") {
        const check = await deadline(inspectExecutable(choice.value), remaining(), "显式浏览器路径检查")
        if (!check.ok) throw renderError("显式浏览器路径无效：" + (check.reason || "不可执行"))
      }
      const resolved = await deadline(resolveModules({ env }), remaining(), "Puppeteer 模块解析")
      modules = resolved.modules || []
      diagnostics = resolved.diagnostics || []
      candidates = modules.map(item => ({ ...item, source: "explicit " + choice.kind, executablePath: choice.kind === "executablePath" ? choice.value : null }))
    } else {
      const resolved = await deadline(discover(), remaining(), "本地浏览器发现")
      candidates = resolved.candidates || []
      diagnostics = resolved.diagnostics || []
      modules = resolved.modules || []
    }
    for (const diagnostic of diagnostics.slice(0, 12)) {
      const detail = typeof diagnostic === "string" ? diagnostic : [diagnostic.source, diagnostic.code, diagnostic.reason || diagnostic.message || diagnostic.detail].filter(Boolean).join("; ") || "候选不可用"
      report("discovery:" + detail, "跳过浏览器候选: " + detail)
    }
    let attempts = 0, lastFailure = ""
    for (const candidate of candidates) {
      if (Date.now() >= until || attempts >= allowance) break
      const key = crypto.createHash("sha256").update(JSON.stringify([candidate.modulePath, candidate.executablePath, choice])).digest("hex")
      if ((failures.get(key) || 0) > Date.now()) continue
      attempts++
      const candidateUntil = Math.min(until, Date.now() + limits.candidateMs)
      const time = () => Math.max(1, candidateUntil - Date.now())
      let entry
      try {
        const driver = candidate.puppeteer
        if (!driver) throw renderError("缺少可用的 Puppeteer 依赖")
        const owner = choice && choice.kind !== "executablePath" ? "connected" : "owned"
        const launch = () => owner === "connected"
          ? driver.connect({ [choice.kind]: choice.value, defaultViewport: null, protocolTimeout: limits.pageMs })
          : driver.launch({
            executablePath: candidate.executablePath, headless: true, timeout: time(), protocolTimeout: limits.pageMs,
            // Retain the pre-existing root-only sandbox exception; ordinary users keep Chrome's sandbox.
            args: process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
          })
        const browser = await deadline(Promise.resolve().then(launch), time(), owner === "connected" ? "显式浏览器连接" : "浏览器启动", late => closeResource(late, owner === "connected" ? "disconnect" : "close"))
        entry = { browser, owner, source: candidate.source || "local", moduleVersion: candidate.moduleVersion, active: 0 }
        owned.add(entry)
        await deadline(validate(entry, time()), time(), "浏览器兼容性验证")
        return entry
      } catch (error) {
        if (entry) await dispose(entry)
        lastFailure = classifyBrowserError(error) + ": " + safeRenderMessage(error)
        failures.set(key, Date.now() + limits.backoffMs)
        if (failures.size > 100) failures.delete(failures.keys().next().value)
        report("candidate:" + key, "浏览器候选失败；来源=" + (candidate.source || "local") + "；类型=" + classifyBrowserError(error) + "；" + safeRenderMessage(error))
      }
    }
    discoveryExpires = Math.min(discoveryExpires, Date.now() + limits.backoffMs)
    const versions = [...new Set([...modules, ...diagnostics.filter(item => item.moduleVersion)].map(item => item.moduleVersion || "unknown"))].join(", ") || "未找到"
    throw renderError((choice ? "显式浏览器配置不可用；不会自动切换到其他浏览器。" : "未找到通过本地截图验证的浏览器。") +
      "当前 Puppeteer: " + versions + "。" + (lastFailure ? "最后失败: " + lastFailure + "。" : "") + "请检查宿主渲染器、浏览器执行权限和共享库；确需安装时，在对应依赖所在工程使用该依赖的浏览器安装命令（如 pnpm exec puppeteer browsers install chrome）。")
  }

  async function independent(choice, until, allowance = limits.maxAttempts) {
    const key = JSON.stringify([choice, env.PUPPETEER_CACHE_DIR || null])
    if (standalone && standalone.key === key && connected(standalone.browser) && !standalone.disposed) return standalone
    if (initializing?.key === key) return initializing.promise
    // Claim both the old owner and the new single-flight job before any await.
    // Otherwise concurrent disconnect/config recovery can start two browsers.
    const previous = standalone
    standalone = null
    if (previous) previous.retired = true
    const marker = generation
    const job = { key, promise: null }
    initializing = job
    job.promise = (async () => {
      if (previous && !previous.active) await dispose(previous)
      if (generation !== marker || initializing !== job) throw renderError("渲染器初始化已取消")
      const entry = await initialize(choice, until, allowance)
      if (generation !== marker || initializing !== job) {
        await dispose(entry)
        throw renderError("渲染器初始化已取消")
      }
      entry.key = key
      standalone = entry
      return entry
    })().finally(() => { if (initializing === job) initializing = null })
    return job.promise
  }

  function checkGeneration(marker) {
    if (marker !== generation) throw renderError("渲染器任务已取消", "RENDER_CANCELLED")
  }

  async function select(event, marker) {
    const until = Date.now() + limits.totalMs
    const choice = explicitChoice()
    if (choice) return independent(choice, until)
    let hosts = []
    try {
      hosts = await deadline(Promise.resolve().then(() => discoverHosts(event)), Math.min(limits.candidateMs, Math.max(1, until - Date.now())), "宿主能力发现")
    } catch (error) { report("host-discovery", "宿主浏览器发现不可用: " + safeRenderMessage(error)) }
    checkGeneration(marker)
    let count = 0
    for (const host of hosts) {
      if (Date.now() >= until || count >= limits.maxAttempts) break
      const identity = host.identity || host.browser
      if (identity && (hostFailures.get(identity) || 0) > Date.now()) continue
      count++
      try {
        const candidateUntil = Math.min(until, Date.now() + limits.candidateMs)
        const time = () => Math.max(1, candidateUntil - Date.now())
        const browser = typeof host.acquire === "function" ? await deadline(Promise.resolve().then(() => host.acquire()), time(), "宿主浏览器初始化") : host.browser
        checkGeneration(marker)
        const entry = { browser, owner: "borrowed", source: host.source || "host", active: 0 }
        return await deadline(validate(entry, time()), time(), "宿主截图能力验证")
      } catch (error) {
        checkGeneration(marker)
        if (identity && ["object", "function"].includes(typeof identity)) hostFailures.set(identity, Date.now() + limits.backoffMs)
        report("host:" + host.source, "宿主候选不可用；来源=" + host.source + "；类型=" + classifyBrowserError(error) + "；" + safeRenderMessage(error))
      }
    }
    if (Date.now() >= until) throw renderError("浏览器初始化总时间预算已耗尽", "RENDER_TIMEOUT")
    checkGeneration(marker)
    return independent(null, until, limits.maxAttempts - count)
  }

  async function withPage(event, callback, { timeoutMs = limits.pageMs } = {}) {
    let selected, active
    const marker = generation
    try {
      selected = await select(event, marker)
      checkGeneration(marker)
      active = await lease(selected, Math.min(limits.candidateMs, timeoutMs))
      return await deadline(Promise.resolve().then(() => { checkGeneration(marker); return callback(active.page) }), timeoutMs, "业务页面渲染")
    } catch (error) {
      if (selected && !connected(selected.browser)) {
        validated.delete(selected.browser)
        if (standalone === selected) standalone = null
        if (selected.owner !== "borrowed") await dispose(selected)
      }
      // A business-page failure never marks a compatible browser as a bad candidate.
      throw renderError((selected ? "页面渲染失败: " : "渲染环境不可用: ") + safeRenderMessage(error), error?.code || (selected ? "RENDER_PAGE" : "RENDER_ENVIRONMENT"))
    } finally { if (active) await active.release() }
  }

  async function close() {
    generation++
    standalone = null
    initializing = null
    validated = new WeakMap()
    hostFailures = new WeakMap()
    discovery = null
    discoveryExpires = 0
    failures.clear()
    messages.clear()
    await Promise.all([...leases].map(release => release()))
    await Promise.all([...owned].map(entry => dispose(entry)))
  }

  const reportFailure = error => report("fallback:" + (error?.code || "render"), "Puppeteer 卡片渲染失败，回退到 default；" + safeRenderMessage(error), "warn")

  return { withPage, close, reportFailure }
}

export const browserManager = createBrowserManager()
