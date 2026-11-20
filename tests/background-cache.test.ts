import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackgroundCache, type CachedBackground } from "../src/data/background-cache";

function background(id: string, bytes: string): CachedBackground {
  return { id, mimeType: "image/jpeg", blob: new Blob([bytes], { type: "image/jpeg" }) };
}

test("底图跨实例保留二进制及类型", async () => {
  const factory = new IDBFactory();
  const writer = new IndexedDbBackgroundCache(factory);
  await writer.put("attachment-1", background("poster-bg", "jpg"));

  const reader = new IndexedDbBackgroundCache(factory);
  const cached = await reader.get("attachment-1");
  assert.ok(cached);
  assert.equal(cached.id, "poster-bg");
  assert.equal(cached.mimeType, "image/jpeg");
  assert.equal(cached.blob.type, "image/jpeg");
  assert.equal(await cached.blob.text(), "jpg");
  assert.equal(await reader.get("attachment-2"), undefined);
});

test("超过字节上限时先淘汰旧底图，读取不影响淘汰顺序", async () => {
  const cache = new IndexedDbBackgroundCache(new IDBFactory(), { maxBytes: 5 });
  await cache.put("z", background("oldest", "ab"));
  await cache.put("b", background("middle", "cd"));
  assert.ok(await cache.get("z"));
  await cache.put("a", background("newest", "efg"));
  await cache.put("oversized", background("oversized", "123456"));

  assert.equal(await cache.get("z"), undefined);
  assert.equal((await cache.get("b"))?.id, "middle");
  assert.equal((await cache.get("a"))?.id, "newest");
  assert.equal(await cache.get("oversized"), undefined);
});

test("并发写入和覆盖同一键后仍遵守条目上限", async () => {
  const factory = new IDBFactory();
  const options = { maxBytes: 6, maxEntries: 2 };
  const first = new IndexedDbBackgroundCache(factory, options);
  const second = new IndexedDbBackgroundCache(factory, options);
  await Promise.all([
    first.put("a", background("first", "ab")),
    second.put("b", background("second", "cd")),
  ]);
  await second.put("a", background("replacement", "efg"));

  assert.equal((await first.get("a"))?.id, "replacement");
  assert.equal((await first.get("b"))?.id, "second");

  await first.put("c", background("third", "h"));
  assert.equal(await second.get("b"), undefined);
  assert.equal((await second.get("a"))?.id, "replacement");
  assert.equal((await second.get("c"))?.id, "third");
});

test("IndexedDB 权限受限时可安全跳过缓存", async (context) => {
  const factory = new IDBFactory();
  context.mock.method(factory, "open", () => {
    throw new DOMException("IndexedDB 不可访问", "SecurityError");
  });
  const cache = new IndexedDbBackgroundCache(factory);
  assert.equal(await cache.get("a"), undefined);
  await cache.put("a", background("a", "jpg"));
});
