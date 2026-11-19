import assert from "node:assert/strict";
import test from "node:test";
import { hashBlob, validatePng } from "../src/data/assets";

test("哈希 Worker 失败时回退主线程计算，两种路径结果一致", async () => {
  const blob = new Blob(["相同字节"], { type: "image/png" });
  const direct = await hashBlob(blob);
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (value: unknown) => warnings.push(value);
  // Worker 在 postMessage 后立即报错，模拟浏览器端 Worker 不可用的场景；
  // 必须在 postMessage 时触发，构造期触发早于主线程挂载 onerror。
  class BrokenWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    postMessage(): void {
      const worker = this;
      queueMicrotask(() => worker.onerror?.({ message: "worker 启动失败" }));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker = BrokenWorker;
  try {
    assert.equal(await hashBlob(blob), direct);
  } finally {
    delete (globalThis as { Worker?: unknown }).Worker;
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [
    { event: "poster.hash.worker_fallback", message: "worker 启动失败" },
  ]);
});

test("validatePng 只接受非空 PNG 文件", () => {
  validatePng(new File([new Uint8Array(1)], "a.png", { type: "image/png" }));
  assert.throws(() => validatePng(new File(["x"], "a.jpg", { type: "image/jpeg" })), {
    code: "INVALID_ASSET",
  });
  assert.throws(() => validatePng(new File([], "a.png", { type: "image/png" })), {
    code: "INVALID_ASSET",
  });
});
