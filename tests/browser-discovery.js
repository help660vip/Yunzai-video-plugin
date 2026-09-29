import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  discoverBrowserCandidates, inspectBrowserExecutable, resolvePuppeteerModules,
} from "../lib/render/browser-discovery.js"

const tests = []
const test = (name, run) => tests.push({ name, run })
const absolute = name => path.resolve("synthetic-browser-discovery", name)
const error = code => Object.assign(new Error(code), { code })

function fixture() {
  const files = new Map()
  const aliases = new Map()
  const resolutions = new Map()
  const imports = new Map()
  const reads = []
  const stats = []
  const requires = []
  let opened = 0
  let closed = 0
  const normalize = file => path.resolve(file)
  const directory = file => {
    file = normalize(file)
    if (!files.has(file)) files.set(file, { directory: true })
    const parent = path.dirname(file)
    if (parent !== file && !files.has(parent)) directory(parent)
    return file
  }
  const put = (file, contents = "", options = {}) => {
    file = normalize(file)
    directory(path.dirname(file))
    files.set(file, { contents: Buffer.from(contents), executable: true, ...options })
    return file
  }
  const lookup = file => {
    const key = normalize(file)
    const item = files.get(aliases.get(key) || key)
    if (!item) throw error("ENOENT")
    return item
  }
  const metadata = item => ({
    isDirectory: () => item.directory === true,
    isFile: () => !item.directory,
    isSymbolicLink: () => item.symbolic === true,
  })
  const io = {
    async stat(file) { stats.push(normalize(file)); return metadata(lookup(file)) },
    async lstat(file) { return metadata(lookup(file)) },
    async realpath(file) { lookup(file); return aliases.get(normalize(file)) || normalize(file) },
    async readFile(file, encoding) {
      const content = lookup(file).contents
      return encoding ? content.toString(encoding) : content
    },
    async access(file, mode) {
      assert.equal(mode, fs.constants.X_OK)
      if (!lookup(file).executable) throw error("EACCES")
    },
    async open(file) {
      const contents = lookup(file).contents
      opened++
      return {
        async read(buffer) { const count = Math.min(buffer.length, contents.length); contents.copy(buffer, 0, 0, count); return { bytesRead: count } },
        async close() { closed++ },
      }
    },
    async readdir(file, options) {
      assert.equal(options.withFileTypes, true)
      lookup(file)
      const key = normalize(file)
      reads.push(key)
      return [...files.entries()].filter(([name]) => path.dirname(name) === key && name !== key)
        .map(([name, value]) => ({ name: path.basename(name), isDirectory: () => value.directory === true && !value.symbolic }))
    },
  }
  const pluginRoot = directory(absolute("host/plugins/parser"))
  const hostRoot = directory(absolute("host"))
  const homeDir = directory(absolute("current-user"))
  const options = {
    fs: io, pluginRoot, cwd: pluginRoot, homeDir, env: {}, platform: "linux", arch: "x64", systemPaths: [],
    requireFactory(anchor) {
      return {
        resolve(name) {
          requires.push({ anchor: normalize(anchor), name })
          const resolved = resolutions.get(normalize(anchor) + "\0" + name)
          if (!resolved) throw error("MODULE_NOT_FOUND")
          return resolved
        },
      }
    },
    async importModule(url) {
      const value = imports.get(normalize(fileURLToPath(url)))
      if (value instanceof Error) throw value
      if (!value) throw error("ERR_MODULE_NOT_FOUND")
      return value
    },
  }
  const module = (anchor, name, version, executablePath, { asynchronous = false, failure = false } = {}) => {
    const entry = put(absolute("store/" + name + "-" + version + "/node_modules/" + name + "/lib/index.js"))
    put(path.resolve(entry, "../../package.json"), JSON.stringify({ name, version }))
    const api = {
      launch() { assert.fail("Discovery must not launch a browser") },
      connect() { assert.fail("Discovery must not connect to a browser") },
      executablePath: asynchronous ? async () => executablePath : () => executablePath,
    }
    resolutions.set(normalize(path.join(anchor, "package.json")) + "\0" + name, entry)
    imports.set(entry, failure ? error("ERR_UNSUPPORTED_RUNTIME") : { default: api })
    return { entry, api }
  }
  return {
    options, io, put, directory, files, aliases, resolutions, imports, reads, stats, requires,
    pluginRoot, hostRoot, homeDir, module, counts: () => ({ opened, closed }),
  }
}

function elf(machine, { bigEndian = false } = {}) {
  const header = Buffer.alloc(20)
  Buffer.from([127, 69, 76, 70, 2, bigEndian ? 2 : 1]).copy(header)
  if (bigEndian) header.writeUInt16BE(machine, 18)
  else header.writeUInt16LE(machine, 18)
  return header
}

test("Plugin and host default paths precede caches and keep their matching modules", async () => {
  const f = fixture()
  const pluginBrowser = f.put(absolute("browsers/plugin"), elf(62))
  const hostBrowser = f.put(absolute("browsers/host"), elf(62))
  const plugin = f.module(f.pluginRoot, "puppeteer", "20.1.0", pluginBrowser, { asynchronous: true })
  const host = f.module(f.hostRoot, "puppeteer", "19.2.0", hostBrowser)
  const result = await discoverBrowserCandidates(f.options)
  assert.deepEqual(result.candidates.map(item => [item.source, item.matched, item.moduleVersion]), [
    ["plugin-default", true, "20.1.0"], ["host-default", true, "19.2.0"],
  ])
  assert.equal(result.candidates[0].puppeteer, plugin.api)
  assert.equal(result.candidates[1].puppeteer, host.api)
  assert.equal(result.modules.length, 2)
  assert.equal(f.requires.some(item => item.anchor === plugin.entry && item.name === "@puppeteer/browsers"), true)
  assert.equal(result.candidates.some(item => "event" in item), false)
})

test("Module resolution uses real entries, ignores duplicate anchors and reports load failures", async () => {
  const f = fixture()
  const browser = f.put(absolute("browsers/shared"), elf(62))
  const plugin = f.module(f.pluginRoot, "puppeteer", "19.0.0", browser)
  f.resolutions.set(path.join(f.hostRoot, "package.json") + "\0puppeteer", plugin.entry)
  f.module(f.hostRoot, "puppeteer-core", "25.0.0", browser, { failure: true })
  const result = await resolvePuppeteerModules({ ...f.options, moduleAnchors: [f.hostRoot, f.hostRoot] })
  assert.equal(result.modules.length, 1)
  assert.equal(result.modules[0].modulePath, plugin.entry)
  assert.equal(result.modules[0].moduleVersion, "19.0.0")
  assert.equal(result.diagnostics.some(item => item.code === "module-load-failed"), true)
})

test("Explicit cache precedes current-user cache; cache versions are not newest-first", async () => {
  const f = fixture()
  const cache = f.directory(absolute("configured-cache"))
  const user = path.join(f.homeDir, ".cache/puppeteer")
  f.put(path.join(cache, "chrome/linux-100/chrome-linux64/chrome"), elf(62))
  f.put(path.join(cache, "chrome/linux-900/chrome-linux64/chrome"), elf(62))
  f.put(path.join(user, "chrome-headless-shell/linux-200/chrome-headless-shell-linux64/chrome-headless-shell"), elf(62))
  f.put(path.join(user, "chromium/linux-300/chrome-linux/chrome"), elf(62))
  const system = f.put(absolute("system/chromium"), "#!/bin/sh\n")
  const result = await discoverBrowserCandidates({ ...f.options, env: { PUPPETEER_CACHE_DIR: cache }, systemPaths: [system] })
  assert.deepEqual(result.candidates.map(item => item.source), ["cache-env", "cache-env", "cache-user", "cache-user", "system"])
  assert.equal(result.candidates[0].executablePath.includes("linux-100"), true)
  assert.equal(result.candidates.every(item => item.matched === false && item.puppeteer === null), true)
})

test("Paired browser-cache API resolves from Puppeteer location and cannot escape cache roots", async () => {
  const f = fixture()
  const cache = f.directory(absolute("cache"))
  const bundled = f.put(absolute("bundled/chrome"), elf(62))
  const plugin = f.module(f.pluginRoot, "puppeteer", "20.0.0", bundled)
  const cached = f.put(path.join(cache, "chrome/linux-100/chrome-linux64/chrome"), elf(62))
  const apiEntry = f.put(absolute("store/browser-api/index.js"))
  const outside = f.put(absolute("other-user/forbidden"), elf(62))
  f.resolutions.set(plugin.entry + "\0@puppeteer/browsers", apiEntry)
  let calls = 0
  f.imports.set(apiEntry, { computeExecutablePath(options) { calls++; assert.equal(options.cacheDir, cache); return outside } })
  const result = await discoverBrowserCandidates({ ...f.options, env: { PUPPETEER_CACHE_DIR: cache } })
  assert.equal(calls, 1)
  assert.equal(result.candidates.some(item => item.executablePath === cached), true)
  assert.equal(f.stats.includes(outside), false)
})

test("Cache scanning is shallow, skips symlink directories and stops at 24 candidates", async () => {
  const f = fixture()
  const cache = f.directory(path.join(f.homeDir, ".cache/puppeteer"))
  for (let i = 0; i < 40; i++) f.put(path.join(cache, "chrome/linux-" + String(i).padStart(3, "0") + "/chrome-linux64/chrome"), elf(62))
  f.put(path.join(cache, "unexpected/nested/chrome"), elf(62))
  f.put(path.join(cache, "chrome/mac-001/chrome-linux64/chrome"), elf(62))
  const symlinked = f.directory(path.join(cache, "chrome-headless-shell"))
  f.files.get(symlinked).symbolic = true
  const result = await discoverBrowserCandidates(f.options)
  assert.equal(result.candidates.length, 24)
  assert.equal(f.reads.every(item => [path.join(cache, "chrome"), path.join(cache, "chromium")].includes(item)), true)
  assert.equal(f.reads.some(item => item.includes("other-user") || item.includes("nested")), false)
})

test("Executable preflight rejects missing files, directories, Linux permissions and wrong ELF architecture", async () => {
  const f = fixture()
  assert.equal((await inspectBrowserExecutable(absolute("missing"), f.options)).reason, "not-found")
  assert.equal((await inspectBrowserExecutable(f.homeDir, f.options)).reason, "not-file")
  const denied = f.put(absolute("denied"), elf(62), { executable: false })
  assert.equal((await inspectBrowserExecutable(denied, f.options)).reason, "not-executable")
  const arm = f.put(absolute("arm-browser"), elf(183))
  assert.equal((await inspectBrowserExecutable(arm, f.options)).reason, "wrong-architecture")
  assert.equal((await inspectBrowserExecutable(arm, { ...f.options, arch: "arm64" })).ok, true)
  assert.equal((await inspectBrowserExecutable(arm, { ...f.options, checkElf: false })).ok, true)
  const shell = f.put(absolute("shell-wrapper"), "#!/bin/sh\nexit 0\n")
  assert.equal((await inspectBrowserExecutable(shell, f.options)).ok, true)
  assert.deepEqual(f.counts(), { opened: 3, closed: 3 })
  assert.equal((await inspectBrowserExecutable("relative-browser", f.options)).reason, "invalid-path")
})

test("Linux ARM caches exclude x64 builds and retain arm64 ELF candidates", async () => {
  const f = fixture()
  const cache = path.join(f.homeDir, ".cache/puppeteer")
  f.put(path.join(cache, "chrome/linux-100/chrome-linux64/chrome"), elf(62))
  const native = f.put(path.join(cache, "chrome/linux_arm-153/chrome-linux-arm64/chrome"), elf(183))
  const result = await discoverBrowserCandidates({ ...f.options, arch: "arm64" })
  assert.deepEqual(result.candidates.map(item => item.executablePath), [native])
})

test("Cache and system preflight failures remain diagnosable without missing-path noise", async () => {
  const f = fixture()
  const missingDefault = absolute("missing-default")
  const missingSystem = absolute("missing-system")
  f.module(f.pluginRoot, "puppeteer", "20.0.0", missingDefault)
  f.module(f.hostRoot, "puppeteer", "19.0.0", missingDefault)
  const denied = f.put(path.join(f.homeDir, ".cache/puppeteer/chrome/linux-100/chrome-linux64/chrome"), elf(62), { executable: false })
  const wrong = f.put(absolute("system/wrong-architecture"), elf(183))
  const result = await discoverBrowserCandidates({ ...f.options, systemPaths: [missingSystem, wrong] })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.diagnostics.some(item => item.source === "plugin-default" && item.code === "not-found"), true)
  assert.equal(result.diagnostics.filter(item => item.executablePath === denied && item.code === "not-executable").length, 1)
  assert.equal(result.diagnostics.filter(item => item.executablePath === wrong && item.code === "wrong-architecture").length, 1)
  assert.equal(result.diagnostics.some(item => item.executablePath === missingSystem), false)
})

test("EPERM is classified as non-executable alongside EACCES", async () => {
  const f = fixture()
  const browser = f.put(absolute("denied-with-eperm"), elf(62))
  const result = await inspectBrowserExecutable(browser, {
    ...f.options, fs: { ...f.io, async access() { throw error("EPERM") } },
  })
  assert.equal(result.reason, "not-executable")
})

test("Cache lstat and readdir permission diagnostics contain safe codes, not raw paths or errors", async () => {
  const f = fixture()
  const cache = path.join(f.homeDir, ".cache/puppeteer")
  const chrome = f.directory(path.join(cache, "chrome"))
  const shell = f.directory(path.join(cache, "chrome-headless-shell"))
  const secretError = code => Object.assign(new Error("private-path https://synthetic-user:synthetic-password@example.invalid"), { code })
  const io = {
    ...f.io,
    async lstat(file) { if (file === chrome) throw secretError("EACCES"); return f.io.lstat(file) },
    async readdir(file, options) { if (file === shell) throw secretError("EPERM"); return f.io.readdir(file, options) },
  }
  const result = await discoverBrowserCandidates({ ...f.options, fs: io })
  const cacheErrors = result.diagnostics.filter(item => item.code === "cache-directory-unavailable")
  assert.deepEqual(cacheErrors.map(item => item.detail), ["EACCES", "EPERM"])
  assert.equal(cacheErrors.every(item => item.source === "cache-user"), true)
  assert.equal(/private-path|synthetic-password|example\.invalid/.test(JSON.stringify(cacheErrors)), false)
  assert.equal(cacheErrors.some(item => "error" in item || "executablePath" in item || "path" in item), false)
})

test("Explicit executable and remote endpoint remain the manager's responsibility", async () => {
  const f = fixture()
  const explicit = f.put(absolute("explicit/chrome"), elf(62))
  const result = await discoverBrowserCandidates({
    ...f.options, env: { PUPPETEER_EXECUTABLE_PATH: explicit, PUPPETEER_BROWSER_WS_ENDPOINT: "ws://127.0.0.1:1/synthetic" },
  })
  assert.equal(result.candidates.length, 0)
  assert.equal(f.stats.includes(explicit), false)
  assert.equal(result.diagnostics.some(item => item.code === "puppeteer-unavailable"), true)
})

test("Windows and macOS fixed cache layouts remain supported", async () => {
  for (const [platform, arch, folder, relative] of [
    ["win32", "x64", "win64-100", "chrome-win64/chrome.exe"],
    ["darwin", "arm64", "mac_arm-100", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
  ]) {
    const f = fixture()
    const file = f.put(path.join(f.homeDir, ".cache/puppeteer/chrome", folder, relative), "synthetic executable")
    const result = await discoverBrowserCandidates({ ...f.options, platform, arch })
    assert.deepEqual(result.candidates.map(item => item.executablePath), [file])
  }
})

let failures = 0
for (const { name, run } of tests) {
  try { await run(); console.log("✓ " + name) }
  catch (error) { failures++; console.error("✗ " + name, error) }
}
console.log((tests.length - failures) + "/" + tests.length + " browser discovery tests passed")
if (failures) process.exitCode = 1
