import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const suites = fs.readdirSync(path.join(root, "tests"))
  .filter(name => name.endsWith(".js"))
  .sort((a, b) => a === "run.js" ? -1 : b === "run.js" ? 1 : a.localeCompare(b))
for (const suite of suites) {
  console.log("\nSuite: " + suite)
  const result = spawnSync(process.execPath, [path.join(root, "tests", suite)], {
    cwd: root, stdio: "inherit", windowsHide: true, timeout: 120000,
  })
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message)
    process.exit(result.status || 1)
  }
}
console.log(`\nAll ${suites.length} suites passed`)
