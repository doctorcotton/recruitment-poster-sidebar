import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createTemplatePackage, parseTemplatePackage } from "../src/application/template-package";
import { rebindTemplateAssetIds } from "../src/application/template-identity";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { TemplateBundle } from "../src/domain/types";

function bundle(): TemplateBundle {
  return {
    template: { ...DEFAULT_TEMPLATE, boxes: DEFAULT_TEMPLATE.boxes.map((box) => ({ ...box })) },
    assets: [
      {
        id: DEFAULT_TEMPLATE.backgroundId,
        name: "底图.png",
        mimeType: "image/png",
        blob: new Blob(["png-bytes"], { type: "image/png" }),
      },
      {
        id: DEFAULT_TEMPLATE.fontIds[0],
        name: "字体.otf",
        mimeType: "font/otf",
        blob: new Blob(["font-bytes"], { type: "font/otf" }),
      },
    ],
  };
}

test("模板包保留声明和原始 Blob 字节，不使用 base64", async () => {
  const expected = bundle();
  const packed = await createTemplatePackage(expected);
  assert.equal(packed.type, "application/zip");
  const restored = await parseTemplatePackage(packed);
  assert.deepEqual(restored.template, expected.template);
  assert.equal(await restored.assets[0].blob.text(), "png-bytes");
  assert.equal(await restored.assets[1].blob.text(), "font-bytes");
});

test("同一内容的多个素材别名在重绑定后自动去重", () => {
  const input = bundle();
  input.template.fontIds = ["noto-bold", "uploaded-font"];
  input.template.boxes = input.template.boxes.map((box) => ({ ...box, fontId: "uploaded-font" }));
  const rebound = rebindTemplateAssetIds(
    input.template,
    new Map([
      ["noto-bold", "asset-same"],
      ["uploaded-font", "asset-same"],
    ]),
    "new-id",
    "新模板",
  );
  assert.deepEqual(rebound.fontIds, ["asset-same"]);
  assert.ok(rebound.boxes.every((box) => box.fontId === "asset-same"));
});

test("模板包拒绝路径穿越和未声明额外文件", async () => {
  const base = await createTemplatePackage(bundle());
  const files = unzipSync(new Uint8Array(await base.arrayBuffer()));
  files["assets/../escape"] = strToU8("bad");
  const malicious = new Blob([zipSync(files)], { type: "application/zip" });
  await assert.rejects(parseTemplatePackage(malicious), /只包含 manifest.json 和 assets/);
});

test("模板包拒绝损坏 manifest 和缺失素材", async () => {
  const missing = new Blob([zipSync({ "manifest.json": strToU8("{}") })]);
  await assert.rejects(parseTemplatePackage(missing), /格式或版本不受支持/);
});

test("模板包兼容混用 STORE 和跨分段 DEFLATE 的旧 ZIP", async () => {
  const packed = await createTemplatePackage(bundle());
  const files = unzipSync(new Uint8Array(await packed.arrayBuffer()));
  const expected = new Uint8Array(6 * 1024 * 1024).fill(87);
  expected[expected.length - 1] = 13;
  const compatible = new Blob([
    zipSync({
      ...files,
      "assets/0": [expected, { level: 6 }],
      "assets/1": [files["assets/1"], { level: 0 }],
    }),
  ]);
  const restored = await parseTemplatePackage(compatible);
  assert.deepEqual(new Uint8Array(await restored.assets[0].blob.arrayBuffer()), expected);
  assert.equal(await restored.assets[1].blob.text(), "font-bytes");
});

test("导出与导入使用相同的文件数上限，包含 manifest", async () => {
  const input = bundle();
  const extra = input.assets[0];
  for (let index = 0; index < 61; index++) input.assets.push({ ...extra, id: `extra-${index}` });
  const packed = await createTemplatePackage(input);
  assert.equal((await parseTemplatePackage(packed)).assets.length, 63);
  input.assets.push({ ...extra, id: "one-more" });
  await assert.rejects(createTemplatePackage(input), { code: "INVALID_TEMPLATE", message: /64/ });
  const files = unzipSync(new Uint8Array(await packed.arrayBuffer()));
  files["assets/63"] = strToU8("extra");
  await assert.rejects(parseTemplatePackage(new Blob([zipSync(files)])), /文件数量/);
});

test("导出按 UTF-8 检查 manifest 大小，导入按原始大小检查", async () => {
  const input = bundle();
  input.assets[0].name = "招".repeat(700_000);
  await assert.rejects(createTemplatePackage(input), /manifest 不能超过 2 MB/);
  const oversized = new Blob([zipSync({ "manifest.json": new Uint8Array(2 * 1024 * 1024 + 1) })]);
  await assert.rejects(parseTemplatePackage(oversized), /manifest 不能超过 2 MB/);
});

test("导出将 ZIP 元数据计入 100 MB，并在读取素材前拒绝超限", async () => {
  class UnreadBlob extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> {
      assert.fail("超限素材不应被读取");
    }
  }
  const input = bundle();
  const blob = new UnreadBlob([new Uint8Array(20 * 1024 * 1024)]);
  input.assets = input.assets.map((asset) => ({ ...asset, blob }));
  for (let index = 0; index < 3; index++)
    input.assets.push({ ...input.assets[0], id: `extra-${index}`, blob });

  await assert.rejects(createTemplatePackage(input), {
    code: "INVALID_ASSET",
    message: /100 MB（含 ZIP 文件头）/,
  });
  const expanded = new Uint8Array(await blob.slice().arrayBuffer());
  const tooLargeOnDisk = new Blob([
    zipSync({
      "manifest.json": strToU8("{}"),
      ...Object.fromEntries(input.assets.map((_, index) => [`assets/${index}`, expanded])),
    }),
  ]);
  await assert.rejects(parseTemplatePackage(tooLargeOnDisk), {
    code: "INVALID_ASSET",
    message: /展开后不能超过 100 MB/,
  });
});

test("导入拒绝超过 20 MB 原始大小的压缩素材", async () => {
  const packed = new Blob([
    zipSync({
      "manifest.json": strToU8("{}"),
      "assets/0": new Uint8Array(20 * 1024 * 1024 + 1),
    }),
  ]);
  await assert.rejects(parseTemplatePackage(packed), { code: "INVALID_ASSET", message: /20 MB/ });
});

test("导入拒绝中央目录低报原始尺寸的素材", async () => {
  const packed = await createTemplatePackage(bundle());
  const files = unzipSync(new Uint8Array(await packed.arrayBuffer()));
  for (const level of [0, 6] as const) {
    const archive = zipSync({ "assets/0": strToU8("png-bytes"), ...files }, { level });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directoryOffset = view.getUint32(archive.length - 22 + 16, true);
    view.setUint32(directoryOffset + 24, 1, true);
    await assert.rejects(parseTemplatePackage(new Blob([archive])), /ZIP 文件大小不一致/);
  }
});

// 浏览器端模板包走 Worker 消息通道，Node 里用假 Worker 全局还原这条路径。
interface FakePackageWorker {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminated: boolean;
  postMessage(): void;
  terminate(): void;
}

function installFakeWorker(reply: (worker: FakePackageWorker) => void): FakePackageWorker[] {
  const created: FakePackageWorker[] = [];
  class Impl implements FakePackageWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    onmessageerror: ((event: unknown) => void) | null = null;
    terminated = false;
    constructor() {
      created.push(this);
    }
    postMessage(): void {
      const worker = this;
      queueMicrotask(() => reply(worker));
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  (globalThis as { Worker?: unknown }).Worker = Impl;
  return created;
}

function uninstallFakeWorker(): void {
  delete (globalThis as { Worker?: unknown }).Worker;
}

test("模板包 Worker 通道成功返回结果，结束后终止 Worker", async () => {
  const created = installFakeWorker((worker) =>
    worker.onmessage?.({ data: { ok: true, result: "fake-zip" } }),
  );
  try {
    const packed = await createTemplatePackage(bundle());
    assert.equal(packed, "fake-zip" as unknown as Blob);
    assert.equal(created.length, 1);
    assert.ok(created[0].terminated);
  } finally {
    uninstallFakeWorker();
  }
});

test("Worker 失败结果、加载错误、消息损坏统一映射为 PosterError", async () => {
  const scenario = { kind: "fail" as "fail" | "load" | "corrupt" };
  installFakeWorker((worker) => {
    if (scenario.kind === "fail")
      worker.onmessage?.({
        data: { ok: false, code: "INVALID_TEMPLATE", message: "包体损坏" },
      });
    else if (scenario.kind === "load") worker.onerror?.({ message: "加载失败" });
    else worker.onmessageerror?.({});
  });
  try {
    await assert.rejects(createTemplatePackage(bundle()), {
      code: "INVALID_TEMPLATE",
      message: "包体损坏",
    });
    scenario.kind = "load";
    await assert.rejects(parseTemplatePackage(new Blob()), { message: /Worker 加载失败/ });
    scenario.kind = "corrupt";
    await assert.rejects(parseTemplatePackage(new Blob()), { message: /无法读取/ });
  } finally {
    uninstallFakeWorker();
  }
});
