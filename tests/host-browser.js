import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { cacheDir } from "../lib/core/paths.js"
import { discoverHostBrowsers } from "../lib/render/host-browser.js"

const tests = []
const test = (name, run) => tests.push({ name, run })
const isolated = { globalObject: false, moduleDiscovery: false }
const event = host => ({ runtime: { puppeteer: host } })
const browser = () => ({ newPage() { return { owner: this } }, isConnected() { return true }, close() { throw new Error("Host browser must not be closed") } })
const temporary = await fs.mkdtemp(path.join(cacheDir, "host-browser-"))

async function fixture(name, packageName = "trss-yunzai") {
  const root = path.join(temporary, name)
  const plugin = path.join(root, "plugins", "video-plugin")
  await fs.mkdir(path.join(root, "lib", "renderer"), { recursive: true })
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: packageName, type: "module" }))
  await fs.writeFile(path.join(root, "lib", "renderer", "loader.js"), "export default {}\n")
  return { root, plugin, module: pathToFileURL(path.join(root, "lib", "renderer", "loader.js")).href }
}

test("Direct runtime browsers are borrowed with no initialization or page allocation", async () => {
  const host = browser()
  let pages = 0
  host.newPage = function () { pages++; return { owner: this } }
  const [candidate] = await discoverHostBrowsers(event(host), isolated)
  assert.equal(candidate.owner, "borrowed")
  assert.equal(candidate.identity, host)
  assert.equal(candidate.browser, host)
  assert.equal(await candidate.acquire(), host)
  assert.equal(pages, 0)
  assert.equal(candidate.browser.newPage().owner, host)
})

test("Page objects yield their owning browser and their shared page remains untouched", async () => {
  const host = browser()
  const page = {
    browser() { assert.equal(this, page); return host },
    goto() { throw new Error("Shared page must not be navigated") },
    screenshot() { throw new Error("Shared page must not be captured") },
    close() { throw new Error("Shared page must not be closed") },
  }
  const [candidate] = await discoverHostBrowsers(event(page), isolated)
  assert.equal(candidate.browser, host)
  assert.equal(candidate.identity, host)
  assert.equal(await candidate.acquire(), host)
})

test("A newPage provider is usable without assuming undocumented browser methods", async () => {
  const factory = { newPage() { return {} } }
  const [candidate] = await discoverHostBrowsers(event(factory), isolated)
  assert.equal(candidate.browser, factory)
  assert.notEqual(candidate.browser.newPage(), candidate.browser.newPage())
})

test("Screenshot-only and render-only schedulers are not accepted as browsers", async () => {
  for (const host of [{ render() {} }, { screenshot() {} }, { render() {}, screenshot() {} }]) {
    assert.deepEqual(await discoverHostBrowsers(event(host), isolated), [])
  }
})

test("Official manager API selects the Puppeteer backend when default is the scheduler", async () => {
  const instance = browser()
  const backend = { browser: instance, browserInit() { throw new Error("Already available") } }
  const argumentsSeen = []
  const manager = { render() {}, getRenderer(name) {
    assert.equal(this, manager)
    argumentsSeen.push(name)
    return name === "puppeteer" ? backend : this
  } }
  const [candidate] = await discoverHostBrowsers(event(manager), isolated)
  assert.deepEqual(argumentsSeen, [undefined, "puppeteer"])
  assert.equal(candidate.identity, backend)
  assert.equal(candidate.browser, instance)
  assert.equal(await candidate.acquire(), instance)
})

test("Configured browser backends take priority and duplicate references are deduplicated", async () => {
  const first = browser(), second = browser()
  const backend = { browser: first }
  const manager = { getRenderer(name) { return name === "puppeteer" ? { browser: second } : backend } }
  const found = await discoverHostBrowsers(event(manager), { ...isolated, globalObject: { puppeteer: backend, browser: first } })
  assert.deepEqual(found.map(value => value.browser), [first, second])
})

test("Backend initialization is lazy, preserves this and is single-flight across events", async () => {
  let calls = 0, finish
  const instance = browser()
  const backend = { browser: false, browserInit() {
    assert.equal(this, backend)
    calls++
    return new Promise(resolve => { finish = () => { this.browser = instance; resolve(instance) } })
  } }
  const [first] = await discoverHostBrowsers(event(backend), isolated)
  const [second] = await discoverHostBrowsers(event(backend), isolated)
  assert.equal(first.identity, backend)
  assert.equal(calls, 0)
  const pending = [first.acquire(), second.acquire()]
  await Promise.resolve()
  assert.equal(calls, 1)
  finish()
  assert.deepEqual(await Promise.all(pending), [instance, instance])
  assert.equal(await first.acquire(), instance)
  assert.equal(calls, 1)
})

test("Failed initializations are cleared and subsequent attempts can succeed", async () => {
  const instance = browser()
  let calls = 0
  const backend = { async browserInit() { if (++calls === 1) throw new Error("Synthetic startup failure"); return instance } }
  const [candidate] = await discoverHostBrowsers(event(backend), isolated)
  await assert.rejects(candidate.acquire(), /Synthetic/)
  assert.equal(await candidate.acquire(), instance)
  assert.equal(calls, 2)
})

test("False initialization results do not poison later acquisitions", async () => {
  const instance = browser()
  let calls = 0
  const backend = { async browserInit() { return ++calls === 1 ? false : instance } }
  const [candidate] = await discoverHostBrowsers(event(backend), isolated)
  assert.equal(await candidate.acquire(), null)
  assert.equal(await candidate.acquire(), instance)
})

test("Disconnected browsers are re-read from the host without closing or mutating it", async () => {
  let connected = true, calls = 0
  const first = browser(), replacement = browser()
  first.isConnected = () => connected
  const backend = { browser: first, async browserInit() { calls++; this.browser = replacement; return replacement } }
  const [candidate] = await discoverHostBrowsers(event(backend), isolated)
  connected = false
  assert.equal(await candidate.acquire(), replacement)
  assert.equal(calls, 1)
  assert.equal((await discoverHostBrowsers(event(backend), isolated))[0].browser, replacement)
  const broken = { newPage() {}, connected: false }
  assert.deepEqual(await discoverHostBrowsers(event(broken), isolated), [])
})

test("A connected replacement bypasses a still-pending initialization", async () => {
  const instance = browser()
  let finish, calls = 0
  const backend = { browser: false, browserInit() { calls++; return new Promise(resolve => { finish = resolve }) } }
  const [candidate] = await discoverHostBrowsers(event(backend), isolated)
  const initial = candidate.acquire()
  await Promise.resolve()
  backend.browser = instance
  assert.equal(await candidate.acquire(), instance)
  assert.equal(calls, 1)
  finish(instance)
  assert.equal(await initial, instance)
})

test("Throwing runtime getters and manager failures permit optional global fallback", async () => {
  const instance = browser()
  const inaccessible = { get runtime() { throw new Error("Synthetic unavailable runtime") } }
  assert.equal((await discoverHostBrowsers(inaccessible, { ...isolated, globalObject: { browser: instance } }))[0].browser, instance)
  const manager = { getRenderer() { throw new Error("Synthetic manager failure") } }
  assert.equal((await discoverHostBrowsers(event(manager), { ...isolated, globalObject: { puppeteer: instance } }))[0].browser, instance)
})

test("Discovery does not cache one event's runtime or share failure identity across bots", async () => {
  const first = browser(), second = browser()
  const a = (await discoverHostBrowsers(event(first), isolated))[0]
  const b = (await discoverHostBrowsers(event(second), isolated))[0]
  assert.equal(a.browser, first)
  assert.equal(b.browser, second)
  assert.notEqual(a.identity, b.identity)
  assert.equal(a.source, b.source)
  assert.deepEqual(await discoverHostBrowsers({}, isolated), [])
})

test("Host module discovery follows plugin ancestors instead of process cwd", async () => {
  const host = await fixture("host with spaces")
  const instance = browser()
  const imports = []
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: host.plugin,
    importModule: async specifier => { imports.push(specifier); return { default: { getRenderer() { return { browser: instance } } } } },
  })
  assert.deepEqual(imports, [host.module])
  assert.equal(found[0].browser, instance)
  assert.equal(fileURLToPath(imports[0]), path.join(host.root, "lib", "renderer", "loader.js"))
})

test("Explicit verified Miao host roots work without assuming the plugin install layout", async () => {
  const host = await fixture("explicit-miao", "miao-yunzai")
  const instance = browser()
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: null, hostRoots: [host.root],
    importModule: async () => ({ default: { browser: instance } }),
  })
  assert.equal(found[0].browser, instance)
})

test("Unrelated packages, relative paths and remote paths never become host module candidates", async () => {
  const host = await fixture("unrelated", "synthetic-other-project")
  let calls = 0
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: null,
    hostRoots: [host.root, ".", new URL("https://example.invalid/host")], importModule: async () => { calls++; return {} },
  })
  assert.deepEqual(found, [])
  assert.equal(calls, 0)
})

test("Legacy singleton module fallback is used without constructing a backend factory", async () => {
  const host = await fixture("legacy-host")
  const legacy = path.join(host.root, "lib", "puppeteer", "puppeteer.js")
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await fs.writeFile(legacy, "export default {}\n")
  const instance = browser(), imports = []
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: host.plugin,
    importModule: async specifier => { imports.push(specifier); if (specifier === host.module) throw new Error("Synthetic unavailable module"); return { default: { browser: instance } } },
  })
  assert.equal(found[0].browser, instance)
  assert.deepEqual(imports, [host.module, pathToFileURL(legacy).href])
})

test("Host singleton symlinks cannot import modules outside the verified host root", async () => {
  const host = await fixture("linked-host")
  const outside = path.join(temporary, "outside-module")
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, "loader.js"), "export default {}\n")
  await fs.unlink(fileURLToPath(host.module))
  const rendererDirectory = path.dirname(fileURLToPath(host.module))
  await fs.rmdir(rendererDirectory)
  await fs.symlink(outside, rendererDirectory, process.platform === "win32" ? "junction" : "dir")
  let imports = 0
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: host.plugin,
    importModule: async () => { imports++; return { default: { browser: browser() } } },
  })
  assert.deepEqual(found, [])
  assert.equal(imports, 0)
})

test("The native file-URL import path works without a cwd-relative import", async () => {
  const host = await fixture("native-import")
  await fs.writeFile(fileURLToPath(host.module), 'export default { browser: { newPage() { return {} } } }\n')
  const found = await discoverHostBrowsers({}, { globalObject: false, pluginRoot: host.plugin })
  assert.equal(found.length, 1)
  assert.equal(typeof found[0].browser.newPage, "function")
})

test("Cached singleton discovery dynamically rereads browser startup and replacement", async () => {
  const host = await fixture("cached-singleton")
  const first = browser(), second = browser()
  const backend = { browser: false, browserInit() { return false } }
  let calls = 0
  const options = { globalObject: false, pluginRoot: host.plugin,
    importModule: async () => { calls++; return { default: backend } },
  }
  const [cold] = await discoverHostBrowsers({}, options)
  assert.equal(await cold.acquire(), null)
  backend.browser = first
  assert.equal((await discoverHostBrowsers({}, options))[0].browser, first)
  backend.browser = second
  assert.equal((await discoverHostBrowsers({}, options))[0].browser, second)
  assert.equal(await cold.acquire(), second)
  assert.equal(calls, 1)
})

test("Negative root discovery expires so a host installed later becomes visible", async () => {
  const host = await fixture("late-host", "synthetic-not-a-host")
  let now = 0, imports = 0
  const instance = browser()
  const options = { globalObject: false, pluginRoot: host.plugin, discoveryTtlMs: 30, now: () => now,
    importModule: async () => { imports++; return { default: { browser: instance } } },
  }
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  await fs.writeFile(path.join(host.root, "package.json"), JSON.stringify({ name: "miao-yunzai", type: "module" }))
  now = 10
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  assert.equal(imports, 0)
  now = 31
  assert.equal((await discoverHostBrowsers({}, options))[0].browser, instance)
  assert.equal(imports, 1)
})

test("Missing singleton files are negatively cached and retried after expiration", async () => {
  const host = await fixture("late-module")
  await fs.unlink(fileURLToPath(host.module))
  let now = 0, imports = 0
  const instance = browser()
  const options = { globalObject: false, pluginRoot: host.plugin, discoveryTtlMs: 30, now: () => now,
    importModule: async () => { imports++; return { default: { browser: instance } } },
  }
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  await fs.writeFile(fileURLToPath(host.module), "export default {}\n")
  now = 10
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  assert.equal(imports, 0)
  now = 31
  assert.equal((await discoverHostBrowsers({}, options))[0].browser, instance)
  assert.equal(imports, 1)
})

test("Failed module imports are bounded by TTL and zero TTL permits an explicit retry", async () => {
  const host = await fixture("retry-module")
  const instance = browser()
  let imports = 0
  const options = { globalObject: false, pluginRoot: host.plugin,
    importModule: async () => { if (++imports === 1) throw new Error("Synthetic import failure"); return { default: { browser: instance } } },
  }
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  assert.deepEqual(await discoverHostBrowsers({}, options), [])
  assert.equal(imports, 1)
  assert.equal((await discoverHostBrowsers({}, { ...options, discoveryTtlMs: 0 }))[0].browser, instance)
  assert.equal(imports, 2)
})

test("A broken event backend does not hide an official singleton browser fallback", async () => {
  const host = await fixture("fallback-from-event")
  const instance = browser()
  const broken = { async browserInit() { throw new Error("Synthetic event backend failure") } }
  const found = await discoverHostBrowsers(event(broken), { globalObject: false, pluginRoot: host.plugin,
    importModule: async () => ({ default: { browser: instance } }),
  })
  assert.equal(found.length, 2)
  assert.equal(found[0].identity, broken)
  await assert.rejects(found[0].acquire(), /Synthetic/)
  assert.equal(await found[1].acquire(), instance)
  assert.match(found[1].source, /^host:/)
})

test("Singleton discovery caches are bounded and old host entries are evicted", async () => {
  const hosts = []
  for (let index = 0; index < 35; index++) hosts.push(await fixture("bounded-host-" + index))
  const calls = new Map()
  const options = { globalObject: false, pluginRoot: null, now: () => 1,
    importModule: async specifier => { calls.set(specifier, (calls.get(specifier) || 0) + 1); return { default: { browser: browser() } } },
  }
  for (const host of hosts) assert.equal((await discoverHostBrowsers({}, { ...options, hostRoots: [host.root] })).length, 1)
  assert.equal(calls.get(hosts[0].module), 1)
  assert.equal((await discoverHostBrowsers({}, { ...options, hostRoots: [hosts[0].root] })).length, 1)
  assert.equal(calls.get(hosts[0].module), 2)
})

let failures = 0
try {
  for (const { name, run } of tests) {
    try { await run(); console.log("PASS " + name) }
    catch (error) { failures++; console.error("FAIL " + name, error) }
  }
} finally {
  const resolved = await fs.realpath(temporary)
  const base = await fs.realpath(cacheDir)
  if (!resolved.startsWith(base + path.sep) || !path.basename(resolved).startsWith("host-browser-")) throw new Error("Unsafe test cleanup path")
  await fs.rm(resolved, { recursive: true, force: true })
}
console.log((tests.length - failures) + "/" + tests.length + " host browser tests passed")
if (failures) process.exitCode = 1
