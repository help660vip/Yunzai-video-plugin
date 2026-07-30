import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export const pluginRoot = path.resolve(currentDir, "../..")
export const configDir = path.join(pluginRoot, "config")
export const dataDir = path.join(pluginRoot, "data")
export const cacheDir = path.join(dataDir, "cache")
export const resourcesDir = path.join(pluginRoot, "resources")

export function ensureRuntimeDirectories() {
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
}

ensureRuntimeDirectories()
