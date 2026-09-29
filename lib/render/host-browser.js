import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pluginDirectory = fileURLToPath(new URL("../../", import.meta.url))
const initializations = new WeakMap()
const hostPackageNames = new Set(["miao-yunzai", "trss-yunzai"])
const rootCache = new Map()
const moduleCaches = new WeakMap()
const importHostModule = specifier => import(specifier)
const DISCOVERY_CACHE_LIMIT = 64
const DISCOVERY_TTL_MS = 30000

function cachedLookup(cache, key, options, load) {
  const requested = Number(options.discoveryTtlMs ?? DISCOVERY_TTL_MS)
  const ttl = Number.isFinite(requested) ? Math.max(0, Math.min(requested, 300000)) : DISCOVERY_TTL_MS
  if (!ttl) return Promise.resolve().then(load).catch(() => null)
  const now = typeof options.now === "function" ? options.now() : Date.now()
  const existing = cache.get(key)
  if (existing && existing.expires > now) {
    cache.delete(key)
    cache.set(key, existing)
    return existing.promise
  }
  // Only paths and singleton exports are cached, never events or browser snapshots.
  const entry = { expires: now + ttl, promise: Promise.resolve().then(load).catch(() => null) }
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > DISCOVERY_CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return entry.promise
}

function objectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

function read(object, key) {
  try { return objectLike(object) ? object[key] : undefined } catch { return undefined }
}

function usableBrowser(value) {
  if (!objectLike(value) || typeof read(value, "newPage") !== "function") return null
  try {
    const connected = read(value, "isConnected")
    if (typeof connected === "function" && !connected.call(value)) return null
    if (read(value, "connected") === false) return null
    return value
  } catch { return null }
}

function existingBrowser(host) {
  const direct = usableBrowser(host)
  if (direct) return direct
  const value = read(host, "browser")
  if (typeof value === "function") {
    // A Page can expose its owning browser, but must never itself be reused.
    if (typeof read(host, "goto") !== "function" || typeof read(host, "screenshot") !== "function") return null
    try { return usableBrowser(value.call(host)) } catch { return null }
  }
  return usableBrowser(value)
}

async function acquireHost(host) {
  const browser = existingBrowser(host)
  if (browser) return browser
  const initialize = read(host, "browserInit")
  if (typeof initialize !== "function") return null
  let pending = initializations.get(host)
  if (!pending) {
    pending = Promise.resolve().then(async () => {
      const current = existingBrowser(host)
      if (current) return current
      const result = await initialize.call(host)
      return existingBrowser(host) || usableBrowser(result)
    })
    initializations.set(host, pending)
    const clear = () => {
      if (initializations.get(host) === pending) initializations.delete(host)
    }
    pending.then(clear, clear)
  }
  return pending
}

function absoluteLocation(value) {
  try {
    if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : null
    if (typeof value !== "string" || !value) return null
    if (value.startsWith("file:")) return fileURLToPath(value)
    return path.isAbsolute(value) ? path.resolve(value) : null
  } catch { return null }
}

async function hostRoots(options) {
  const candidates = new Set()
  for (const value of options.hostRoots || []) {
    const directory = absoluteLocation(value)
    if (directory) candidates.add(directory)
  }
  let directory = absoluteLocation(options.pluginRoot === undefined ? pluginDirectory : options.pluginRoot)
  // Inspect only the plugin's ancestor manifests, never enumerate user directories.
  for (let depth = 0; directory && depth < 16; depth++) {
    candidates.add(directory)
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const verified = new Set()
  for (const candidate of candidates) {
    const root = await cachedLookup(rootCache, candidate, options, async () => {
      const manifestPath = path.join(candidate, "package.json")
      const stat = await fs.stat(manifestPath)
      if (!stat.isFile() || stat.size > 65536) return null
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
      if (!hostPackageNames.has(manifest.name)) return null
      return fs.realpath(candidate)
    })
    if (root) verified.add(root)
  }
  return [...verified]
}

async function existingModule(root, relative) {
  try {
    const file = await fs.realpath(path.join(root, ...relative.split("/")))
    const inside = path.relative(root, file)
    if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) return null
    return (await fs.stat(file)).isFile() ? pathToFileURL(file).href : null
  } catch { return null }
}

/**
 * Discover borrowed Browser/newPage providers without opening or closing pages.
 * `acquire` reads the backend afresh and may initialize it; callers own deadlines.
 * `identity` is the backend/browser, not the event, for per-provider retry limits.
 * Options: pluginRoot/hostRoots are trusted absolute locations; globalObject=false
 * and moduleDiscovery=false disable those fallbacks. importModule is injectable.
 * Discovery caches positive/negative paths and singleton modules for 30 seconds;
 * discoveryTtlMs (zero disables caching) and now may be injected for tests.
 */
export async function discoverHostBrowsers(event, options = {}) {
  const output = []
  const seen = new Set()
  const browsers = new Set()
  const inspect = (host, source, depth = 0) => {
    if (!objectLike(host) || seen.has(host) || depth > 8) return
    seen.add(host)
    const browser = existingBrowser(host)
    if (browser && !browsers.has(browser)) {
      browsers.add(browser)
      const identity = typeof read(host, "browser") === "function" ? browser : host
      output.push({ source, owner: "borrowed", identity, browser, acquire: () => acquireHost(host) })
    } else if (!browser && typeof read(host, "browserInit") === "function") {
      output.push({ source, owner: "borrowed", identity: host, acquire: () => acquireHost(host) })
    }
    // Both supported hosts expose this manager API. render/screenshot alone is
    // not a browser, and the global Renderer base class is not the manager.
    const getRenderer = read(host, "getRenderer")
    if (typeof getRenderer === "function") {
      try { inspect(getRenderer.call(host), source + ".getRenderer()", depth + 1) } catch {}
      try { inspect(getRenderer.call(host, "puppeteer"), source + ".getRenderer(puppeteer)", depth + 1) } catch {}
    }
  }

  const runtime = read(event, "runtime")
  inspect(read(runtime, "puppeteer"), "event.runtime.puppeteer")
  const globals = options.globalObject === undefined ? globalThis : options.globalObject
  if (globals) {
    inspect(read(globals, "puppeteer"), "global.puppeteer")
    inspect(read(globals, "browser"), "global.browser")
    inspect(read(globals, "renderer"), "global.renderer")
    inspect(read(globals, "Renderer"), "global.Renderer")
  }
  if (options.moduleDiscovery === false) return output

  // Import only the host's singleton entrypoints. Importing a backend factory
  // and constructing it would create a second, unowned browser manager.
  const importer = options.importModule || importHostModule
  let modules = moduleCaches.get(importer)
  if (!modules) {
    modules = new Map()
    moduleCaches.set(importer, modules)
  }
  for (const root of await hostRoots(options)) {
    for (const relative of ["lib/renderer/loader.js", "lib/puppeteer/puppeteer.js"]) {
      const module = await cachedLookup(modules, path.join(root, relative), options, async () => {
        const specifier = await existingModule(root, relative)
        return specifier ? importer(specifier) : null
      })
      inspect(read(module, "default"), "host:" + relative)
    }
  }
  return output
}
