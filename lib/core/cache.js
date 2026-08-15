export class LimitedMap extends Map {
  constructor(maxSize = 50) {
    super()
    this.maxSize = maxSize
  }

  get(key) {
    return super.get(key)
  }

  set(key, value) {
    super.set(key, value)
    while (this.size > this.maxSize) {
      super.delete(this.keys().next().value)
    }
    return this
  }
}

export class ExpiringLimitedMap extends LimitedMap {
  constructor(maxSize = 50, ttlMs = 30 * 60 * 1000) {
    super(maxSize)
    this.ttlMs = ttlMs
    this.expires = new Map()
  }

  get(key) {
    const expiresAt = this.expires.get(key)
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.delete(key)
      return undefined
    }
    return super.get(key)
  }

  has(key) {
    const expiresAt = this.expires.get(key)
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.delete(key)
      return false
    }
    return super.has(key)
  }

  set(key, value) {
    super.set(key, value)
    this.expires.set(key, Date.now() + this.ttlMs)
    for (const storedKey of this.expires.keys()) {
      if (!super.has(storedKey)) this.expires.delete(storedKey)
    }
    return this
  }

  delete(key) {
    this.expires.delete(key)
    return super.delete(key)
  }

  clear() {
    this.expires.clear()
    super.clear()
  }
}

export const resultCache = new ExpiringLimitedMap(50)
