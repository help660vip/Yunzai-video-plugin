import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MAX_CANDIDATES = 24
const MAX_CACHE_ENTRIES = 24
const MAX_MODULE_ANCHORS = 8
const importModule = specifier => import(specifier)
const ELF_MACHINES = { ia32: 3, x64: 62, arm: 40, arm64: 183, ppc64: 21, s390x: 22, riscv64: 243 }

function dependencies(options) {
  return {
    fs: options.fs || fs.promises,
    requireFactory: options.requireFactory || createRequire,
    importModule: options.importModule || importModule,
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    env: options.env || process.env,
  }
}

function code(error) {
  if (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code
  return ["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError", "AggregateError"].includes(error?.name)
    ? error.name : "unavailable"
}

function anchors(options) {
  const root = path.resolve(options.pluginRoot || DEFAULT_ROOT)
  const values = [{ path: root, source: "plugin" }, ...(options.moduleAnchors || []).map(value =>
    typeof value === "string" ? { path: value, source: "host" } : value)]
  if (path.basename(path.dirname(root)).toLowerCase() === "plugins") {
    values.push({ path: path.resolve(root, "../.."), source: "host" })
  }
  values.push({ path: options.cwd || process.cwd(), source: "host" })
  const seen = new Set()
  return values.filter(value => {
    if (!value || typeof value.path !== "string" || !path.isAbsolute(value.path)) return false
    const key = path.resolve(value.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_MODULE_ANCHORS)
}

async function moduleVersion(modulePath, io) {
  let directory = path.dirname(modulePath)
  for (let depth = 0; depth < 8; depth++) {
    try {
      const metadata = JSON.parse(await io.readFile(path.join(directory, "package.json"), "utf8"))
      if (["puppeteer", "puppeteer-core"].includes(metadata.name)) return String(metadata.version || "")
    } catch {}
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ""
}

/** Resolve optional plugin/host packages from their real locations, including pnpm stores. */
export async function resolvePuppeteerModules(options = {}) {
  const deps = dependencies(options)
  const modules = []
  const diagnostics = []
  const seen = new Set()
  for (const anchor of anchors(options)) {
    let anchorFile = anchor.path
    try {
      if ((await deps.fs.stat(anchorFile)).isDirectory()) anchorFile = path.join(anchorFile, "package.json")
    } catch {
      if (!/\.(?:[cm]?js|json)$/i.test(anchorFile)) anchorFile = path.join(anchorFile, "package.json")
    }
    for (const name of ["puppeteer", "puppeteer-core"]) {
      let modulePath
      try {
        modulePath = deps.requireFactory(anchorFile).resolve(name)
        modulePath = await deps.fs.realpath(modulePath)
      } catch { continue }
      if (seen.has(modulePath)) continue
      seen.add(modulePath)
      const version = await moduleVersion(modulePath, deps.fs)
      try {
        const imported = await deps.importModule(pathToFileURL(modulePath).href)
        const puppeteer = imported.default || imported
        if (typeof puppeteer.launch !== "function" && typeof puppeteer.connect !== "function") {
          diagnostics.push({ source: anchor.source || "host", code: "invalid-puppeteer-api", modulePath })
          continue
        }
        modules.push({
          puppeteer, modulePath, moduleVersion: version,
          source: anchor.source || "host",
        })
      } catch (error) {
        diagnostics.push({ source: anchor.source || "host", code: "module-load-failed", modulePath, moduleVersion: version, detail: code(error) })
      }
    }
  }
  if (!modules.length) diagnostics.push({ source: "module", code: "puppeteer-unavailable" })
  return { modules, diagnostics }
}

/** Read-only preflight. Compatibility is decided by the browser manager, not this check. */
export async function inspectBrowserExecutable(executablePath, options = {}) {
  const deps = dependencies(options)
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) return { ok: false, reason: "invalid-path" }
  try {
    if (!(await deps.fs.stat(executablePath)).isFile()) return { ok: false, reason: "not-file" }
    if (deps.platform !== "win32") await deps.fs.access(executablePath, fs.constants.X_OK)
    if (deps.platform === "linux" && options.checkElf !== false) {
      const handle = await deps.fs.open(executablePath, "r")
      try {
        const header = Buffer.alloc(20)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        if (bytesRead >= 20 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
          const machine = header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18)
          if (ELF_MACHINES[deps.arch] && machine !== ELF_MACHINES[deps.arch]) {
            return { ok: false, reason: "wrong-architecture" }
          }
        }
      } finally { await handle.close() }
    }
    return { ok: true, executablePath: await deps.fs.realpath(executablePath) }
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "not-found" : ["EACCES", "EPERM"].includes(error?.code) ? "not-executable" : "unreadable" }
  }
}

function cachePlatform(platform, arch) {
  if (platform === "linux") return arch === "arm64" ? "linux_arm" : arch === "x64" ? "linux" : null
  if (platform === "darwin") return arch === "arm64" ? "mac_arm" : arch === "x64" ? "mac" : null
  if (platform === "win32") return arch === "ia32" ? "win32" : "win64"
  return null
}

function relativeExecutables(browser, platform) {
  const directory = { linux: "linux64", linux_arm: "linux-arm64", mac: "mac-x64", mac_arm: "mac-arm64", win32: "win32", win64: "win64" }[platform]
  if (browser === "chromium") {
    if (platform.startsWith("linux")) return ["chrome-linux/chrome"]
    if (platform.startsWith("mac")) return ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
    return ["chrome-win/chrome.exe", "chrome-win32/chrome.exe"]
  }
  if (browser === "chrome-headless-shell") {
    return ["chrome-headless-shell-" + directory + "/chrome-headless-shell" + (platform.startsWith("win") ? ".exe" : "")]
  }
  if (platform.startsWith("mac")) return ["chrome-" + directory + "/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
  const paths = ["chrome-" + directory + "/chrome" + (platform.startsWith("win") ? ".exe" : "")]
  if (platform === "linux_arm") paths.push("chrome-linux64/chrome")
  return paths
}

function systemExecutables(platform, env) {
  if (platform === "linux") return [
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/lib/chromium/chromium", "/snap/bin/chromium",
  ]
  if (platform === "darwin") return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]
  if (platform === "win32") {
    const roots = [env.ProgramFiles || env.PROGRAMFILES, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean)
    return roots.flatMap(root => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ])
  }
  return []
}

async function cacheApi(modules, deps) {
  for (const module of modules) {
    try {
      const entry = deps.requireFactory(module.modulePath).resolve("@puppeteer/browsers")
      const api = await deps.importModule(pathToFileURL(entry).href)
      if (typeof api.computeExecutablePath === "function") return api
    } catch {}
  }
  return null
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

/** Discover at most 24 candidates; never launch, install, recursively search, or select a newest build. */
export async function discoverBrowserCandidates(options = {}) {
  const deps = dependencies(options)
  const { modules, diagnostics } = await resolvePuppeteerModules(options)
  const candidates = []
  const seen = new Set()
  const checked = new Map()
  const reported = new Set()
  const add = async (executablePath, source, module, matched = false) => {
    if (candidates.length >= MAX_CANDIDATES) return
    if (!checked.has(executablePath)) checked.set(executablePath, await inspectBrowserExecutable(executablePath, options))
    const inspection = checked.get(executablePath)
    if (!inspection.ok) {
      const key = source + "\0" + executablePath + "\0" + inspection.reason
      if ((matched || inspection.reason !== "not-found") && !reported.has(key)) {
        reported.add(key)
        diagnostics.push({ source, code: inspection.reason, executablePath })
      }
      return
    }
    const key = inspection.executablePath + "\0" + (module?.modulePath || "")
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      source, executablePath: inspection.executablePath, puppeteer: module?.puppeteer || null,
      modulePath: module?.modulePath || null, moduleVersion: module?.moduleVersion || "", matched,
    })
  }
  for (const module of modules) {
    if (typeof module.puppeteer.executablePath !== "function") continue
    try {
      await add(await module.puppeteer.executablePath(), module.source + "-default", module, true)
    } catch (error) {
      diagnostics.push({ source: module.source, code: "default-executable-unavailable", modulePath: module.modulePath, detail: code(error) })
    }
  }

  const fallbackModules = modules.length ? modules : [null]
  const roots = []
  if (deps.env.PUPPETEER_CACHE_DIR) roots.push({ path: path.resolve(deps.env.PUPPETEER_CACHE_DIR), source: "cache-env" })
  roots.push({ path: path.join(options.homeDir || os.homedir(), ".cache", "puppeteer"), source: "cache-user" })
  const platform = cachePlatform(deps.platform, deps.arch)
  const api = platform ? await cacheApi(modules, deps) : null
  const seenRoots = new Set()
  for (const root of roots) {
    if (!platform || seenRoots.has(root.path) || candidates.length >= MAX_CANDIDATES) continue
    seenRoots.add(root.path)
    for (const browser of ["chrome", "chrome-headless-shell", "chromium"]) {
      let entries
      const directory = path.join(root.path, browser)
      try {
        const stat = await deps.fs.lstat(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        entries = await deps.fs.readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code !== "ENOENT") {
          diagnostics.push({ source: root.source, code: "cache-directory-unavailable", browser, detail: code(error) })
        }
        continue
      }
      entries = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(platform + "-"))
        .sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_CACHE_ENTRIES)
      for (const entry of entries) {
        if (candidates.length >= MAX_CANDIDATES) break
        const buildId = entry.name.slice(platform.length + 1)
        if (!/^[a-zA-Z0-9._-]+$/.test(buildId)) continue
        const paths = relativeExecutables(browser, platform).map(relative => path.join(directory, entry.name, relative))
        if (api) {
          try {
            const computed = await api.computeExecutablePath({ cacheDir: root.path, browser, platform, buildId })
            if (typeof computed === "string" && isWithin(root.path, computed)) paths.unshift(computed)
          } catch {}
        }
        for (const executablePath of new Set(paths)) {
          for (const module of fallbackModules) await add(executablePath, root.source, module)
        }
      }
    }
  }
  for (const executablePath of options.systemPaths || systemExecutables(deps.platform, deps.env)) {
    for (const module of fallbackModules) await add(executablePath, "system", module)
  }
  return { candidates, diagnostics, modules }
}
