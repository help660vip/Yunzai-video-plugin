import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const files = []

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "data") continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath)
    else if (entry.name.endsWith(".js")) files.push(fullPath)
  }
}

walk(root)
let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
    windowsHide: true,
  })
  if (result.status !== 0) failed = true
}
if (failed) process.exitCode = 1
else console.log(`Syntax OK: ${files.length} JavaScript files`)
