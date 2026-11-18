export interface RequestCacheOptions {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  estimateBytes?: (value: unknown) => number;
}
interface Entry {
  value: unknown;
  expiresAt: number;
  bytes: number;
}

function defaultBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Object.values(value).reduce((sum, item) => sum + defaultBytes(item, seen), 64);
}

/** 有界 LRU + 同键合并；失效后，旧请求不得重新填充缓存或删除新请求。 */
export class RequestCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly estimateBytes: (value: unknown) => number;
  private bytes = 0;

  constructor(options: RequestCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.estimateBytes = options.estimateBytes ?? defaultBytes;
  }

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return Promise.resolve(existing.value as T);
    }
    if (existing) this.remove(key, existing);
    const inflight = this.pending.get(key);
    if (inflight) return inflight as Promise<T>;
    // LRU 只淘汰已完成值，在途项不占缓存位，也不会因淘汰而发起重复请求。
    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        if (this.pending.get(key) === request) {
          const bytes = this.estimateBytes(value);
          if (bytes <= this.maxBytes) {
            this.entries.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
            this.bytes += bytes;
            this.trim();
          }
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }

  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.remove(oldestKey, this.entries.get(oldestKey)!);
    }
  }

  invalidate(matches?: (key: string) => boolean): void {
    if (!matches) {
      this.entries.clear();
      this.pending.clear();
      this.bytes = 0;
      return;
    }
    for (const [key, entry] of this.entries) if (matches(key)) this.remove(key, entry);
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key);
  }
}
