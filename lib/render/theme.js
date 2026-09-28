// Native data-only theme runtime. See LICENSE for rendering contract attribution.
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import crypto from "node:crypto"
import { config } from "../core/config.js"
import { configDir, dataDir } from "../core/paths.js"

export const THEME_SCHEMA_VERSION = 1
export const MUSIC_PLATFORMS = new Set(["kugou", "netease", "kuwo", "qsmusic"])
const ID = /^[a-z0-9][a-z0-9._-]*$/
const MAX_TEMPLATE_BYTES = 1024 * 1024
const forbidden = new Set(["__proto__", "constructor", "prototype"])

export function escapeThemeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character])
}

export async function safeThemeFile(root, name) {
  if (typeof name !== "string" || path.isAbsolute(name) || name.includes("\\")) return null
  if (name.split("/").some(part => !part || part === ".." || part === ".")) return null
  try {
    const resolvedRoot = await fs.realpath(root)
    const target = await fs.realpath(path.resolve(resolvedRoot, name))
    const relative = path.relative(resolvedRoot, target)
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) return null
    return (await fs.stat(target)).isFile() ? target : null
  } catch { return null }
}

async function loadTheme(root) {
  try {
    const filename = await safeThemeFile(root, "theme.json")
    if (!filename || (await fs.stat(filename)).size > 65536) return null
    const manifest = JSON.parse(await fs.readFile(filename, "utf8"))
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !ID.test(manifest.id || "")) return null
    if ((manifest.schema_version ?? 1) !== THEME_SCHEMA_VERSION) return null
    return {
      id: manifest.id,
      name: typeof manifest.name === "string" ? manifest.name : manifest.id,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      author: typeof manifest.author === "string" ? manifest.author : "",
      root: await fs.realpath(root),
    }
  } catch { return null }
}

export async function listThemes(directories = config.parser_theme_dirs || []) {
  const themes = new Map()
  for (const directory of [...directories, path.join(dataDir, "themes")]) {
    const root = path.resolve(configDir, directory)
    const direct = await loadTheme(root)
    if (direct) {
      if (!themes.has(direct.id)) themes.set(direct.id, direct)
      continue
    }
    let children
    try { children = await fs.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue
      const theme = await loadTheme(path.join(root, child.name))
      if (theme && !themes.has(theme.id)) themes.set(theme.id, theme)
    }
  }
  if (!themes.has("default")) themes.set("default", { id: "default", name: "默认", version: "1", root: null })
  return [...themes.values()]
}

export async function resolveTheme(platform, options = {}) {
  const themes = await listThemes(options.directories)
  const id = options.id ?? config.parser_render_theme ?? "default"
  const selected = themes.find(theme => theme.id === id) || themes.find(theme => theme.id === "default")
  if (!selected.root) return { ...selected, key: "builtin-2", template: null, css: "", baseUrl: null }
  const candidates = [ID.test(platform || "") ? `${platform}.html` : null,
    MUSIC_PLATFORMS.has(platform) ? "music.html" : null, "default.html"].filter(Boolean)
  let template = null
  for (const name of candidates) {
    const file = await safeThemeFile(selected.root, name)
    if (file && (await fs.stat(file)).size <= MAX_TEMPLATE_BYTES) {
      template = await fs.readFile(file, "utf8")
      break
    }
  }
  const cssPath = await safeThemeFile(selected.root, "style.css")
  const css = cssPath && (await fs.stat(cssPath)).size <= MAX_TEMPLATE_BYTES ? await fs.readFile(cssPath, "utf8") : ""
  return { ...selected, template, css, baseUrl: pathToFileURL(selected.root + path.sep).href,
    key: crypto.createHash("sha256").update(selected.id + selected.version + (template || "") + css).digest("hex") }
}

function readValue(expression, scope) {
  expression = expression.trim()
  if (/^(?:"(?:[^"\\]|\\.)*"|'[^']*')$/.test(expression)) {
    return expression.startsWith('"') ? JSON.parse(expression) : expression.slice(1, -1)
  }
  const compare = /^(.+?)\s*(===|!==|==|!=)\s*(.+)$/.exec(expression)
  if (compare) {
    const equal = readValue(compare[1], scope) === readValue(compare[3], scope)
    return compare[2].includes("!") ? !equal : equal
  }
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression)
  if (expression === "true") return true
  if (expression === "false") return false
  if (expression === "null") return null
  const names = expression.trim().split(".")
  if (!names.every(name => /^(?:[A-Za-z_$][\w$]*|\d+|@index)$/.test(name) && !forbidden.has(name))) return undefined
  let value = scope
  for (const name of names) {
    if (!value || !Object.prototype.hasOwnProperty.call(Object(value), name)) return undefined
    value = value[name]
  }
  return value
}

// Templates cannot evaluate JavaScript or access process/filesystem objects.
export function renderThemeTemplate(template, data) {
  const root = []
  const stack = [{ children: root }]
  for (const token of template.split(/({{[\s\S]*?}})/g)) {
    const parent = stack[stack.length - 1]
    if (!token.startsWith("{{")) { parent.children.push({ text: token }); continue }
    const expression = token.slice(2, -2).trim()
    const block = /^#(each|if|unless)\s+(.+)$/.exec(expression)
    if (block) {
      const node = { kind: block[1], expression: block[2], children: [], alternate: null }
      parent.children.push(node)
      stack.push(node)
    } else if (expression.startsWith("/")) {
      if (stack.length === 1 || parent.kind !== expression.slice(1)) throw new Error("主题模板的区块不匹配")
      stack.pop()
    } else if (expression === "else") {
      if (stack.length === 1 || !["if", "unless"].includes(parent.kind) || parent.alternate !== null) throw new Error("主题模板的 else 区块无效")
      parent.alternate = []
      stack[stack.length - 1] = { ...parent, children: parent.alternate }
    } else if (expression.startsWith("#")) throw new Error("主题模板包含不支持的语法")
    else parent.children.push({ expression })
  }
  if (stack.length !== 1) throw new Error("主题模板存在未关闭区块")
  let visits = 0, outputLength = 0
  const bounded = value => {
    outputLength += value.length
    if (outputLength > 32 * 1024 * 1024) throw new Error("主题输出超过安全大小上限")
    return value
  }
  const render = (nodes, scope, depth = 0) => {
    if (depth > 40) throw new Error("主题模板嵌套过深")
    return nodes.map(node => {
      if (++visits > 50000) throw new Error("主题模板展开次数过多")
      if (node.text !== undefined) return bounded(node.text)
      const value = readValue(node.expression, scope)
      if (node.kind === "each") return Array.isArray(value) ? value.slice(0, 1000).map((item, index) => render(node.children, { ...scope, this: item, "@index": index }, depth + 1)).join("") : ""
      if (node.kind === "if" || node.kind === "unless") {
        const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value)
        return truthy === (node.kind === "if") ? render(node.children, scope, depth + 1) : render(node.alternate || [], scope, depth + 1)
      }
      return ["string", "number", "boolean"].includes(typeof value) ? bounded(escapeThemeHtml(value)) : ""
    }).join("")
  }
  return render(root, { data, ...data })
}
