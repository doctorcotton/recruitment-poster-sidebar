import assert from "node:assert/strict";
import test from "node:test";
import { RequestCache } from "../src/data/request-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("缓存合并同键在途请求，完成后开始 TTL，过期重新读取", async () => {
  let now = 0;
  let calls = 0;
  const cache = new RequestCache({ ttlMs: 10, now: () => now });
  const request = deferred<string>();
  const first = cache.get("same", () => {
    calls++;
    return request.promise;
  });
  now = 100;
  const second = cache.get("same", async () => {
    calls++;
    return "duplicate";
  });
  assert.equal(first, second);
  request.resolve("value");
  assert.equal(await first, "value");
  assert.equal(calls, 1);
  now = 109;
  assert.equal(await cache.get("same", async () => "too early"), "value");
  now = 110;
  assert.equal(await cache.get("same", async () => "fresh"), "fresh");
  assert.equal(await cache.get("another", async () => "isolated"), "isolated");
});

test("失败不缓存，不吞异常，下一次调用正常重试", async () => {
  const cache = new RequestCache();
  const expected = new Error("unavailable");
  await assert.rejects(
    cache.get("failure", async () => {
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.equal(await cache.get("failure", async () => "recovered"), "recovered");
  await assert.rejects(
    cache.get("sync", () => {
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.equal(await cache.get("sync", async () => "recovered"), "recovered");
});

test("失效后旧 pending 成功不得填回，也不得覆盖新请求", async () => {
  const cache = new RequestCache();
  const stale = deferred<string>();
  const first = cache.get("key", () => stale.promise);
  cache.invalidate();
  const fresh = cache.get("key", async () => "new");
  assert.equal(await fresh, "new");
  stale.resolve("old");
  assert.equal(await first, "old");
  assert.equal(await cache.get("key", async () => "unexpected"), "new");
});

test("失效后旧 pending 失败不得删除新请求", async () => {
  const cache = new RequestCache();
  const stale = deferred<string>();
  const first = cache.get("key", () => stale.promise);
  cache.invalidate();
  assert.equal(await cache.get("key", async () => "new"), "new");
  const rejected = assert.rejects(first, /old failure/);
  stale.reject(new Error("old failure"));
  await rejected;
  assert.equal(await cache.get("key", async () => "unexpected"), "new");
});

test("不同实例没有共享缓存", async () => {
  const first = new RequestCache();
  const second = new RequestCache();
  assert.equal(await first.get("same", async () => "a"), "a");
  assert.equal(await second.get("same", async () => "b"), "b");
});

test("LRU 限制条目数并优先保留最近读取", async () => {
  let now = 0;
  const cache = new RequestCache({ maxEntries: 2, ttlMs: 100, now: () => now });
  await cache.get("a", async () => "A");
  await cache.get("b", async () => "B");
  assert.equal(await cache.get("a", async () => "stale"), "A");
  await cache.get("c", async () => "C");
  assert.equal(await cache.get("b", async () => "B-new"), "B-new");
  assert.equal(await cache.get("a", async () => "A-new"), "A-new");
  assert.equal(await cache.get("c", async () => "C-new"), "C-new");
});

test("Blob 缓存按实际字节淘汰且超大值不驻留", async () => {
  const cache = new RequestCache({ maxBytes: 8, maxEntries: 10, ttlMs: 100 });
  await cache.get("a", async () => new Blob(["1234"]));
  await cache.get("b", async () => new Blob(["5678"]));
  assert.equal(
    await cache.get("a", async () => new Blob(["stale"])).then((blob) => blob.text()),
    "1234",
  );
  await cache.get("c", async () => new Blob(["9012"]));
  assert.equal(
    await cache.get("b", async () => new Blob(["new"])).then((blob) => blob.text()),
    "new",
  );
  await cache.get("huge", async () => new Blob(["123456789"]));
  assert.equal(
    await cache.get("huge", async () => new Blob(["fresh"])).then((blob) => blob.text()),
    "fresh",
  );
});

test("字节预算涵盖嵌套素材，条目压力下相同在途请求仍合并", async () => {
  const cache = new RequestCache({ maxEntries: 1, maxBytes: 128 });
  const a = deferred<string>();
  const first = cache.get("a", () => a.promise);
  const second = cache.get("b", async () => "B");
  assert.equal(
    cache.get("a", async () => "重复请求"),
    first,
  );
  assert.equal(await second, "B");
  a.resolve("A");
  assert.equal(await first, "A");

  const asset = { blob: new Blob([new Uint8Array(256)]) };
  assert.equal(await cache.get("asset", async () => asset), asset);
  assert.equal(await cache.get("asset", async () => "新素材"), "新素材");
});
