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

export const resultCache = new LimitedMap(50)
