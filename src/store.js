class MemoryStore {
  constructor() {
    this.values = new Map();
    this.lists = new Map();
    this.timers = new Map();
  }

  async get(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  async set(key, value) {
    this.values.set(key, String(value));
    return "OK";
  }

  async incr(key) {
    const current = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, String(current));
    return current;
  }

  async expire(key, ttlSeconds) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }
    const timeoutId = setTimeout(() => {
      this.values.delete(key);
      this.lists.delete(key);
      this.timers.delete(key);
    }, Math.max(0, Number(ttlSeconds)) * 1000);
    this.timers.set(key, timeoutId);
    return 1;
  }

  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const normalizedStart = start < 0 ? Math.max(list.length + start, 0) : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(normalizedStart, normalizedStop + 1);
  }

  async rpush(key, value) {
    const list = this.lists.get(key) || [];
    list.push(String(value));
    this.lists.set(key, list);
    return list.length;
  }

  async quit() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.values.clear();
    this.lists.clear();
  }
}

module.exports = {
  MemoryStore
};
