import type { PosterAsset } from "../domain/types";

export type CachedBackground = Pick<PosterAsset, "id" | "mimeType" | "blob">;

export interface BackgroundCache {
  get(key: string): Promise<CachedBackground | undefined>;
  put(key: string, asset: CachedBackground): Promise<void>;
}

const STORE = "backgrounds";
const SIZE_INDEX = "storedAtAndSize";

interface StoredBackground {
  id: string;
  mimeType: string;
  bytes: ArrayBuffer;
  byteLength: number;
  storedAt: number;
}

export class IndexedDbBackgroundCache implements BackgroundCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(
    private readonly factory: IDBFactory,
    options?: { maxBytes?: number; maxEntries?: number },
  ) {
    this.maxBytes = options?.maxBytes ?? 48 * 1024 * 1024;
    this.maxEntries = options?.maxEntries ?? 128;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open("recruitment-poster-feishu-backgrounds", 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE).createIndex(SIZE_INDEX, ["storedAt", "byteLength"]);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("底图缓存数据库被阻塞。"));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(request.result);
      };
    });
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    start: (store: IDBObjectStore) => () => T,
  ): Promise<T> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE, mode);
      return await new Promise<T>((resolve, reject) => {
        transaction.onabort = () => reject(transaction.error);
        const result = start(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(result());
      });
    } finally {
      database.close();
    }
  }

  async get(key: string): Promise<CachedBackground | undefined> {
    try {
      const stored = await this.transaction("readonly", (store) => {
        const request = store.get(key);
        return () => request.result as StoredBackground | undefined;
      });
      if (stored) {
        return {
          id: stored.id,
          mimeType: stored.mimeType,
          blob: new Blob([stored.bytes], { type: stored.mimeType }),
        };
      }
    } catch {
      // 缓存不可用时，由调用方继续在线下载。
    }
  }

  async put(key: string, asset: CachedBackground): Promise<void> {
    if (asset.blob.size > this.maxBytes || this.maxEntries < 1) return;
    try {
      // 以 ArrayBuffer 保存二进制，兼容 WebKit。
      const bytes = await asset.blob.arrayBuffer();
      await this.transaction("readwrite", (store) => {
        let totalBytes = bytes.byteLength;
        let entryCount = 1;
        let storedAt = Date.now();
        const entries: { key: IDBValidKey; byteLength: number }[] = [];
        // 键游标只遍历时间与大小，淘汰时不读取底图内容。
        const request = store.index(SIZE_INDEX).openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const [timestamp, byteLength] = cursor.key as [number, number];
            storedAt = Math.max(storedAt, timestamp + 1);
            if (cursor.primaryKey !== key) {
              entries.push({ key: cursor.primaryKey, byteLength });
              totalBytes += byteLength;
              entryCount += 1;
            }
            cursor.continue();
            return;
          }
          for (const entry of entries) {
            if (totalBytes <= this.maxBytes && entryCount <= this.maxEntries) break;
            store.delete(entry.key);
            totalBytes -= entry.byteLength;
            entryCount -= 1;
          }
          const record: StoredBackground = {
            id: asset.id,
            mimeType: asset.mimeType,
            bytes,
            byteLength: bytes.byteLength,
            storedAt,
          };
          store.put(record, key);
        };
        return () => undefined;
      });
    } catch {
      // 缓存写入失败不影响已下载的底图。
    }
  }
}
