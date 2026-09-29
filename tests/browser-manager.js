import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { classifyBrowserError, createBrowserManager, safeRenderMessage } from "../lib/render/browser-manager.js"

// Synthetic lifecycle coverage, not a Debian 12 real-browser run.
const tests = []
const test = (name, run) => tests.push([name, run])
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function browserMock({ contexts = true, onPage = null } = {}) {
  const browser = new EventEmitter()
  Object.assign(browser, {
    connected: true, pagesCreated: [], contextsCreated: [], closes: 0, disconnects: 0,
    isConnected() { return this.connected },
    async version() { return "Synthetic Browser" },
    async newPage() {
      assert.equal(this, browser, "newPage must preserve the Browser receiver")
      const page = new EventEmitter()
      Object.assign(page, {
        closes: 0, html: [], screenshots: 0, currentViewport: {},
        async setViewport(value) { this.currentViewport = value },
        async setJavaScriptEnabled() {},
        async setRequestInterception() {},
        async setContent(value) { this.html.push(value) },
        async goto() {},
        async evaluate() { return true },
        async screenshot() { this.screenshots++; return png },
        async $() { return {} },
        async $eval() { return { x: 0, y: 0, width: 1, height: 1 } },
        viewport() { return this.currentViewport },
        isClosed() { return this.closes > 0 },
        async close() { this.closes++ },
      })
      this.pagesCreated.push(page)
      await onPage?.(page, this.pagesCreated.length)
      return page
    },
    async close() { this.closes++; this.connected = false; this.emit("disconnected") },
    disconnect() { this.disconnects++; this.connected = false; this.emit("disconnected") },
  })
  if (contexts) browser.createBrowserContext = async function () {
    assert.equal(this, browser, "context creation must preserve the Browser receiver")
    const context = {
      closes: 0, pages: [],
      async newPage() {
        assert.equal(this, context, "newPage must preserve the Context receiver")
        const page = await browser.newPage()
        this.pages.push(page)
        return page
      },
      async close() {
        this.closes++
        for (const page of this.pages) if (!page.isClosed()) await page.close()
      },
    }
    browser.contextsCreated.push(context)
    return context
  }
  return browser
}

function fixture({ browsers = [browserMock()], candidates, hosts = [], env = {}, limits = {}, ...overrides } = {}) {
  const calls = { discover: 0, hosts: 0, launch: [], connect: [], inspect: [], modules: 0, logs: [] }
  const puppeteer = {
    async launch(options) {
      assert.equal(this, puppeteer, "launch must preserve the Puppeteer receiver")
      calls.launch.push(options)
      return browsers[Math.min(calls.launch.length - 1, browsers.length - 1)]
    },
    async connect(options) {
      assert.equal(this, puppeteer, "connect must preserve the Puppeteer receiver")
      calls.connect.push(options)
      return browsers[0]
    },
  }
  const modules = [{ puppeteer, modulePath: "/synthetic/puppeteer/index.js", moduleVersion: "0.0.0", source: "synthetic module" }]
  const candidateList = candidates || [{ source: "synthetic paired browser", executablePath: "/synthetic/browser", puppeteer, moduleVersion: "0.0.0", matched: true }]
  const manager = createBrowserManager({
    env,
    logger: Object.fromEntries(["debug", "info", "warn", "error", "mark", "success"].map(level => [level, (...args) => calls.logs.push(args)])),
    limits: { candidateMs: 200, totalMs: 1000, pageMs: 200, maxAttempts: 6, backoffMs: 20, discoveryTtlMs: 10000, ...limits },
    discoverHosts: async event => { calls.hosts++; return typeof hosts === "function" ? hosts(event) : hosts },
    discoverCandidates: async () => { calls.discover++; return { candidates: candidateList, diagnostics: [], modules } },
    resolveModules: async () => { calls.modules++; return { modules, diagnostics: [] } },
    inspectExecutable: async executablePath => { calls.inspect.push(executablePath); return { ok: true, executablePath } },
    ...overrides,
  })
  return { manager, calls, puppeteer, browsers, candidateList }
}

async function using(setup, run) {
  try { await run(setup) } finally { await setup.manager.close() }
}

function assertReleased(browser) {
  assert(browser.pagesCreated.every(page => page.closes === 1), "each created Page must be released exactly once")
  assert(browser.contextsCreated.every(context => context.closes === 1), "each plugin Context must be released exactly once")
}

test("working host avoids resolving the plugin's unavailable default browser", async () => {
  const browser = browserMock()
  await using(fixture({ hosts: [{ source: "host browser", browser }] }), async ({ manager, calls }) => {
    const result = await manager.withPage({ runtime: {} }, async page => { assert(!page.isClosed()); return "中文卡片" })
    assert.equal(result, "中文卡片")
    assert.equal(calls.discover, 0)
    assert.equal(calls.launch.length, 0)
    assert.equal(calls.modules, 0)
    assertReleased(browser)
    await manager.close()
    assert.equal(browser.closes, 0)
    assert.equal(browser.disconnects, 0)
  })
})

test("host acquisition preserves this and concurrent requests share one probe", async () => {
  const browser = browserMock()
  const host = { source: "host backend", marker: true, async acquire() { assert.equal(this, host); return browser } }
  const gate = deferred(), seen = new Set()
  await using(fixture({ hosts: [host] }), async ({ manager }) => {
    const tasks = Array.from({ length: 5 }, () => manager.withPage({}, async page => {
      assert(!seen.has(page)); seen.add(page)
      if (seen.size === 5) gate.resolve()
      await gate.promise
      assert(!page.isClosed(), "a different request must not close this Page")
    }))
    await Promise.all(tasks)
    assert.equal(browser.pagesCreated.filter(page => page.screenshots > 0).length, 1)
    assert.equal(seen.size, 5)
    assertReleased(browser)
    assert.equal(browser.closes, 0)
  })
})

test("without an event, independent discovery initializes once under concurrency", async () => {
  const browser = browserMock()
  const setup = fixture({ browsers: [browser] })
  await using(setup, async ({ manager, calls }) => {
    const pages = await Promise.all(Array.from({ length: 6 }, () => manager.withPage(undefined, async page => page)))
    assert.equal(new Set(pages).size, 6)
    assert.equal(calls.launch.length, 1)
    assert.equal(calls.discover, 1)
    assertReleased(browser)
  })
  assert.equal(browser.closes, 1)
  assert.equal(browser.disconnects, 0)
})

test("a Browser without isolated contexts releases only its own Pages", async () => {
  const browser = browserMock({ contexts: false })
  await using(fixture({ hosts: [{ source: "old host", browser }] }), async ({ manager }) => {
    await manager.withPage({}, async () => "ok")
    assertReleased(browser)
    assert.equal(browser.contextsCreated.length, 0)
  })
  assert.equal(browser.closes, 0)
})

test("business rendering errors release the Page without rejecting a healthy browser", async () => {
  const browser = browserMock()
  await using(fixture({ browsers: [browser] }), async ({ manager, calls }) => {
    const businessError = new Error("synthetic template error")
    await assert.rejects(manager.withPage(undefined, async () => { throw businessError }), error => error === businessError || /template/.test(error.message))
    assert.equal(await manager.withPage(undefined, async () => "recovered"), "recovered")
    assert.equal(calls.launch.length, 1)
    assertReleased(browser)
  })
})

test("business screenshot timeout closes its Page and the next request recovers", async () => {
  const browser = browserMock(), stalled = deferred()
  await using(fixture({ hosts: [{ source: "host", browser }] }), async ({ manager }) => {
    let timedOutPage
    await assert.rejects(manager.withPage({}, async page => { timedOutPage = page; return stalled.promise }, { timeoutMs: 20 }), /timeout|超时/i)
    assert(timedOutPage.isClosed())
    stalled.resolve("late result")
    assert.equal(await manager.withPage({}, async () => "recovered"), "recovered")
    assertReleased(browser)
    assert.equal(browser.closes, 0)
  })
})

test("disconnected independent browser is reinitialized on the next request", async () => {
  const old = browserMock(), replacement = browserMock()
  await using(fixture({ browsers: [old, replacement] }), async ({ manager, calls }) => {
    await manager.withPage(undefined, async () => {})
    old.connected = false; old.emit("disconnected")
    await manager.withPage(undefined, async () => {})
    assert.equal(calls.launch.length, 2)
    assertReleased(old)
    assertReleased(replacement)
  })
})

test("concurrent recovery shares one initialization while the previous Browser is still closing", async () => {
  for (const mode of ["disconnect", "explicit-change"]) {
    const old = browserMock(), replacement = browserMock(), closing = deferred(), finishClose = deferred()
    const env = mode === "explicit-change" ? { PUPPETEER_EXECUTABLE_PATH: "/explicit/old" } : {}
    const originalClose = old.close
    let closeCalls = 0
    old.close = async function () {
      assert.equal(this, old)
      closeCalls++
      closing.resolve()
      await finishClose.promise
      return originalClose.call(this)
    }
    await using(fixture({ browsers: [old, replacement], env }), async ({ manager, calls }) => {
      await manager.withPage(undefined, async () => {})
      if (mode === "disconnect") { old.connected = false; old.emit("disconnected") }
      else env.PUPPETEER_EXECUTABLE_PATH = "/explicit/new"
      const first = manager.withPage(undefined, async page => page)
      try {
        await closing.promise
        const second = manager.withPage(undefined, async page => page)
        await pause(10)
        finishClose.resolve()
        const renderedPages = await Promise.all([first, second])
        assert.notEqual(renderedPages[0], renderedPages[1])
        assert.equal(calls.launch.length, 2, mode + " must launch exactly one replacement Browser")
        assert.equal(closeCalls, 1, mode + " must dispose the previous owner exactly once")
        assertReleased(old)
        assertReleased(replacement)
      } finally { finishClose.resolve() }
    })
    assert.equal(replacement.closes, 1)
  }
})

test("host browsers are reobtained after disconnect without ever being closed", async () => {
  const old = browserMock(), replacement = browserMock()
  let current = old
  await using(fixture({ hosts: () => [{ source: "host", browser: current }] }), async ({ manager, calls }) => {
    await manager.withPage({}, async () => {})
    old.connected = false; old.emit("disconnected"); current = replacement
    await manager.withPage({}, async () => {})
    assert.equal(calls.launch.length, 0)
    assertReleased(old); assertReleased(replacement)
  })
  assert.equal(old.closes + replacement.closes + old.disconnects + replacement.disconnects, 0)
})

test("host acquire refreshes a stale browser snapshot before validation", async () => {
  const stale = browserMock(), fresh = browserMock()
  let acquisitions = 0
  const host = { source: "changing backend", browser: stale, async acquire() {
    assert.equal(this, host)
    acquisitions++
    return fresh
  } }
  await using(fixture({ hosts: [host] }), async ({ manager, calls }) => {
    await manager.withPage({}, async () => {})
    assert.equal(acquisitions, 1)
    assert.equal(stale.pagesCreated.length, 0)
    assert(fresh.pagesCreated.length >= 2)
    assert.equal(calls.launch.length, 0)
    assertReleased(fresh)
  })
  assert.equal(stale.closes + fresh.closes + stale.disconnects + fresh.disconnects, 0)
})

test("explicit executable wins without inheriting a shared userDataDir", async () => {
  const browser = browserMock()
  await using(fixture({ browsers: [browser], env: { PUPPETEER_EXECUTABLE_PATH: "/explicit/browser" }, hosts: [{ source: "host", browser: browserMock() }] }), async ({ manager, calls }) => {
    await manager.withPage({}, async () => {})
    assert.equal(calls.launch.length, 1)
    assert.equal(calls.launch[0].executablePath, "/explicit/browser")
    assert.equal(calls.launch[0].userDataDir, undefined)
    assert.equal(calls.hosts, 0)
    assert.equal(calls.discover, 0)
  })
})

test("invalid explicit executable fails closed instead of silently using a host", async () => {
  await using(fixture({ env: { PUPPETEER_EXECUTABLE_PATH: "/missing/browser" }, hosts: [{ source: "available host", browser: browserMock() }], inspectExecutable: async executablePath => ({ ok: false, reason: "not executable", executablePath }) }), async ({ manager, calls }) => {
    await assert.rejects(manager.withPage({}, async () => assert.fail("must not render")), /explicit|显式|可执行|executable/i)
    assert.equal(calls.launch.length, 0)
    assert.equal(calls.hosts, 0)
    assert.equal(calls.discover, 0)
  })
})

test("conflicting explicit settings fail before host, launch or connection", async () => {
  await using(fixture({ env: { PUPPETEER_EXECUTABLE_PATH: "/explicit/browser", PUPPETEER_BROWSER_URL: "http://127.0.0.1:1" } }), async ({ manager, calls }) => {
    await assert.rejects(manager.withPage(undefined, async () => assert.fail()), /冲突|多个|conflict|only one/i)
    assert.equal(calls.hosts + calls.discover + calls.launch.length + calls.connect.length, 0)
  })
})

test("plugin-created connections disconnect rather than closing shared Chrome", async () => {
  for (const key of ["PUPPETEER_BROWSER_WS_ENDPOINT", "PUPPETEER_BROWSER_URL"]) {
    const browser = browserMock()
    const endpoint = key.endsWith("WS_ENDPOINT") ? "ws://127.0.0.1:1/devtools/browser/synthetic" : "http://127.0.0.1:1"
    const setup = fixture({ browsers: [browser], env: { [key]: endpoint } })
    await using(setup, async ({ manager, calls }) => {
      await manager.withPage({}, async () => {})
      assert.equal(calls.connect.length, 1)
      assert.equal(calls.launch.length, 0)
      assertReleased(browser)
    })
    assert.equal(browser.closes, 0)
    assert.equal(browser.disconnects, 1)
  }
})

test("explicit connections retain the business-page protocol timeout budget", async () => {
  await using(fixture({
    env: { PUPPETEER_BROWSER_WS_ENDPOINT: "ws://127.0.0.1:1/devtools/browser/synthetic-budget" },
    limits: { candidateMs: 40, pageMs: 750 },
  }), async ({ manager, calls }) => {
    await manager.withPage(undefined, async () => {})
    assert.equal(calls.connect.length, 1)
    assert.equal(calls.connect[0].protocolTimeout, 750, "connected business pages must not inherit the short candidate deadline")
  })
})

test("failed explicit connections redact credentials and debugging endpoints", async () => {
  const endpoint = "ws://synthetic-user:synthetic-secret@127.0.0.1:1/devtools/browser/private-id?token=private-token"
  const setup = fixture({ env: { PUPPETEER_BROWSER_WS_ENDPOINT: endpoint } })
  setup.puppeteer.connect = async () => { throw new Error("connection failed: " + endpoint) }
  await using(setup, async ({ manager, calls }) => {
    let failure
    try { await manager.withPage({}, async () => assert.fail()) } catch (error) { failure = error }
    assert(failure)
    const rendered = String(failure.stack) + JSON.stringify(calls.logs)
    for (const secret of ["synthetic-user", "synthetic-secret", "private-id", "private-token", endpoint]) assert(!rendered.includes(secret), "diagnostics must redact endpoint secrets")
    assert.equal(calls.hosts, 0)
    assert.equal(calls.discover, 0)
  })
})

test("failed compatibility probe closes that candidate and tries a bounded fallback", async () => {
  const incompatible = browserMock({ onPage: page => { page.screenshot = async () => { throw new Error("Protocol error") } } })
  const working = browserMock()
  const setup = fixture({ browsers: [incompatible, working] })
  setup.candidateList.push({ ...setup.candidateList[0], source: "validated fallback", executablePath: "/synthetic/fallback" })
  await using(setup, async ({ manager, calls }) => {
    await manager.withPage(undefined, async () => {})
    assert.equal(incompatible.closes, 1)
    assert.equal(calls.launch.length, 2)
    assertReleased(incompatible); assertReleased(working)
    await manager.withPage(undefined, async () => {})
    assert.equal(calls.launch.length, 2, "successful combinations should be reused")
    assert.equal(calls.discover, 1)
  })
})

test("validation uses a minimal offline page rather than platform content", async () => {
  const browser = browserMock()
  await using(fixture({ browsers: [browser] }), async ({ manager }) => {
    await manager.withPage(undefined, async () => {})
    const probes = browser.pagesCreated.filter(page => page.screenshots > 0)
    assert.equal(probes.length, 1)
    assert(probes[0].html.length > 0)
    assert(!/https?:\/\//i.test(probes[0].html.join("")))
    assertReleased(browser)
  })
})

test("rejected initialization retries after short backoff instead of staying cached", async () => {
  const setup = fixture()
  const launch = setup.puppeteer.launch
  let attempts = 0
  setup.puppeteer.launch = async function (options) {
    if (++attempts === 1) throw new Error("synthetic startup failure")
    return launch.call(this, options)
  }
  await using(setup, async ({ manager }) => {
    await assert.rejects(manager.withPage(undefined, async () => {}))
    await pause(35)
    assert.equal(await manager.withPage(undefined, async () => "recovered"), "recovered")
    assert.equal(attempts, 2)
  })
})

test("failed candidates respect the maximum attempt count", async () => {
  const setup = fixture({ limits: { maxAttempts: 2 } })
  setup.candidateList.push(...Array.from({ length: 7 }, (_, i) => ({ ...setup.candidateList[0], executablePath: "/synthetic/candidate-" + i })))
  let attempts = 0
  setup.puppeteer.launch = async () => { attempts++; throw new Error("synthetic failure") }
  await using(setup, async ({ manager }) => {
    await assert.rejects(manager.withPage(undefined, async () => {}))
    assert.equal(attempts, 2)
  })
})

test("launch resolution after timeout still closes the plugin-owned browser", async () => {
  const browser = browserMock(), launch = deferred()
  const setup = fixture({ browsers: [browser], limits: { candidateMs: 20, totalMs: 60, maxAttempts: 1 } })
  setup.puppeteer.launch = () => launch.promise
  await using(setup, async ({ manager }) => {
    await assert.rejects(manager.withPage(undefined, async () => assert.fail()), /超时|timeout|失败|browser|浏览器/i)
    launch.resolve(browser)
    await pause(35)
    assert.equal(browser.closes, 1)
  })
})

test("late Page allocation is released without closing a timed-out host Browser", async () => {
  const allocation = deferred(), browser = browserMock({ contexts: false, onPage: () => allocation.promise })
  await using(fixture({ hosts: [{ source: "slow host", browser }], candidates: [], limits: { candidateMs: 20, totalMs: 50, maxAttempts: 1 } }), async ({ manager }) => {
    await assert.rejects(manager.withPage({}, async () => assert.fail()))
    allocation.resolve()
    await pause(35)
    assertReleased(browser)
    assert.equal(browser.closes + browser.disconnects, 0)
  })
})

test("total initialization budget stops slow candidates before the attempt cap", async () => {
  const launches = [], setup = fixture({ limits: { candidateMs: 20, totalMs: 35, maxAttempts: 6 } })
  setup.candidateList.push(...Array.from({ length: 6 }, (_, i) => ({ ...setup.candidateList[0], executablePath: "/slow/candidate-" + i })))
  setup.puppeteer.launch = () => { launches.push(deferred()); return launches[launches.length - 1].promise }
  await using(setup, async ({ manager }) => {
    const started = Date.now()
    await assert.rejects(manager.withPage(undefined, async () => assert.fail()))
    assert(launches.length >= 1 && launches.length <= 2, "total budget must limit attempts")
    assert(Date.now() - started < 1000, "initialization must not wait for all stalled candidates")
    const browsers = launches.map(() => browserMock())
    launches.forEach((launch, i) => launch.resolve(browsers[i]))
    await pause(30)
    assert(browsers.every(browser => browser.closes === 1))
  })
})

test("failed candidates and diagnostics remain quiet during short backoff", async () => {
  const setup = fixture({ limits: { backoffMs: 1000 } })
  let attempts = 0
  setup.puppeteer.launch = async () => { attempts++; throw new Error("synthetic unavailable browser") }
  await using(setup, async ({ manager, calls }) => {
    await assert.rejects(manager.withPage(undefined, async () => {}))
    const logs = calls.logs.length
    await assert.rejects(manager.withPage(undefined, async () => {}))
    assert.equal(attempts, 1)
    assert.equal(calls.discover, 1)
    assert.equal(calls.logs.length, logs)
  })
})

test("changing an explicit browser waits for active Pages before retiring its owner", async () => {
  const first = browserMock(), second = browserMock(), started = deferred(), finish = deferred()
  const env = { PUPPETEER_EXECUTABLE_PATH: "/explicit/first" }
  await using(fixture({ browsers: [first, second], env }), async ({ manager, calls }) => {
    const active = manager.withPage(undefined, async page => {
      started.resolve()
      await finish.promise
      assert(!page.isClosed())
    })
    await started.promise
    env.PUPPETEER_EXECUTABLE_PATH = "/explicit/second"
    await manager.withPage(undefined, async () => {})
    assert.equal(calls.launch.length, 2)
    assert.equal(first.closes, 0, "an active render must retain the old owner")
    finish.resolve()
    await active
    assert.equal(first.closes, 1)
    assertReleased(first)
  })
})

test("manager shutdown cancels initialization and disposes its eventual Browser", async () => {
  const browser = browserMock(), launch = deferred(), started = deferred()
  const setup = fixture()
  setup.puppeteer.launch = () => { started.resolve(); return launch.promise }
  await using(setup, async ({ manager }) => {
    const pending = manager.withPage(undefined, async () => assert.fail("shutdown must cancel pending render"))
    const rejection = assert.rejects(pending)
    await started.promise
    await manager.close()
    launch.resolve(browser)
    await rejection
    assert.equal(browser.closes, 1)
    assertReleased(browser)
  })
})

test("shutdown cancels pending host acquisition without touching its Browser and new requests recover", async () => {
  const browser = browserMock(), acquired = deferred(), started = deferred()
  let acquisitions = 0, callbacks = 0
  const host = { source: "pending host backend", async acquire() {
    assert.equal(this, host)
    acquisitions++
    if (acquisitions === 1) { started.resolve(); return acquired.promise }
    return browser
  } }
  await using(fixture({ hosts: [host] }), async ({ manager, calls }) => {
    const pending = manager.withPage({}, async () => { callbacks++; assert.fail("shutdown must cancel the old callback") })
    const rejection = assert.rejects(pending)
    await started.promise
    await manager.close()
    acquired.resolve(browser)
    await rejection
    assert.equal(callbacks, 0)
    assert.equal(browser.pagesCreated.length, 0, "a late host acquisition must not create probe or business Pages")
    assert.equal(browser.contextsCreated.length, 0)
    assert.equal(browser.closes + browser.disconnects, 0)
    assert(browser.isConnected())
    assert.equal(calls.launch.length, 0, "a cancelled request must not fall back to independent launch")
    assert.equal(await manager.withPage({}, async () => { callbacks++; return "recovered" }), "recovered")
    assert.equal(acquisitions, 2)
    assert.equal(callbacks, 1)
    assert.equal(calls.launch.length, 0)
    assertReleased(browser)
  })
  assert.equal(browser.closes + browser.disconnects, 0)
})

test("a connection resolving after timeout is disconnected but never closed", async () => {
  const browser = browserMock(), connection = deferred()
  const setup = fixture({ env: { PUPPETEER_BROWSER_URL: "http://127.0.0.1:1" }, limits: { candidateMs: 20, maxAttempts: 1 } })
  setup.puppeteer.connect = () => connection.promise
  await using(setup, async ({ manager }) => {
    await assert.rejects(manager.withPage(undefined, async () => assert.fail()))
    connection.resolve(browser)
    await pause(30)
    assert.equal(browser.disconnects, 1)
    assert.equal(browser.closes, 0)
  })
})

test("diagnostics distinguish environment failures and remove auth values", () => {
  for (const [message, expected] of [
    ["EACCES permission denied", "permission"],
    ["Exec format error: wrong architecture", "architecture"],
    ["error while loading shared libraries: libexample.so", "shared-library"],
    ["Running as root without --no-sandbox", "sandbox"],
    ["Could not find Chrome", "missing"],
    ["ECONNREFUSED websocket connection", "connection"],
    ["Protocol error: target closed", "protocol"],
    ["operation timed out", "timeout"],
  ]) assert.equal(classifyBrowserError(new Error(message)), expected)
  const safe = safeRenderMessage(new Error("token=private-token Cookie=private-cookie Authorization=private-auth https://user:pass@example.invalid/private-debug?token=value"))
  for (const secret of ["private-token", "private-cookie", "private-auth", "private-debug", "user:pass"]) assert(!safe.includes(secret))
})

test("diagnostics redact full Authorization and Cookie lines across newline styles", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "connection failed",
      "Authorization: Bearer multi-word-secret",
      "Cookie: first=first-private; session=second-private; token=third-private",
      "TOKEN = multi word token value",
      "next line has safe diagnostics",
    ].join(newline)
    const safe = safeRenderMessage(new Error(source))
    for (const secret of ["multi-word-secret", "first-private", "second-private", "third-private", "multi word token value"]) assert(!safe.includes(secret))
    assert(safe.includes("connection failed"))
    assert(safe.includes("next line has safe diagnostics"))
  }
})

for (const [name, run] of tests) { await run(); console.log("PASS " + name) }
console.log("Browser manager mock lifecycle: " + tests.length + " tests passed (not a Debian 12 real-browser run)")
