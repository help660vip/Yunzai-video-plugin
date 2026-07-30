function call(level, args) {
  const target = globalThis.logger
  if (target && typeof target[level] === "function") return target[level](...args)
  const fallback = level === "mark" || level === "success" ? "log" : level
  return (console[fallback] || console.log)(...args)
}

export const log = {
  debug: (...args) => call("debug", args),
  info: (...args) => call("info", args),
  warn: (...args) => call("warn", args),
  error: (...args) => call("error", args),
  mark: (...args) => call("mark", args),
  success: (...args) => call("success", args),
}
