import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { PosterAsset, TemplateBundle } from "../src/domain/types";
import { createPosterRenderer } from "../src/rendering";

function setupBrowser(t: TestContext) {
  const images: TestImage[] = [];
  const canvases: TestCanvas[] = [];
  const fonts = new Set<TestFont>();
  const fontLoads: TestFont[] = [];
  class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 100;
    naturalHeight = 100;
    src = "";
    decodeCount = 0;
    constructor() {
      images.push(this);
    }
    async decode() {
      this.decodeCount++;
    }
    removeAttribute() {
      this.src = "";
    }
  }
  class TestFont {
    constructor(public family: string) {}
    async load() {
      fontLoads.push(this);
      return this;
    }
  }
  class TestCanvas {
    width = 300;
    height = 150;
    encodedSize: number[] | undefined;
    encode: ((blob: Blob | null) => void) | undefined;
    context = {
      drawImage: t.mock.fn(),
      scale: t.mock.fn(),
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillText: t.mock.fn(),
      measureText: (text: string) => ({
        width: text.length * 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
      }),
    };
    getContext() {
      return this.context;
    }
    toBlob(callback: (blob: Blob | null) => void) {
      this.encodedSize = [this.width, this.height];
      this.encode = callback;
    }
  }
  const mocks = {
    Image: TestImage,
    FontFace: TestFont,
    document: {
      fonts,
      createElement: () => {
        const canvas = new TestCanvas();
        canvases.push(canvas);
        return canvas;
      },
    },
  };
  const restore = Object.entries(mocks).map(([name, value]) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    return () => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    };
  });
  const createUrl = t.mock.method(URL, "createObjectURL", () => `blob:${images.length}`);
  const revokeUrl = t.mock.method(URL, "revokeObjectURL", () => {});
  const renderer = createPosterRenderer();
  t.after(() => {
    renderer.dispose();
    for (const restoreGlobal of restore) restoreGlobal();
  });
  return { renderer, images, canvases, fonts, fontLoads, TestCanvas, createUrl, revokeUrl };
}

const asCanvas = (canvas: unknown) => canvas as HTMLCanvasElement;
const asset = (id: string, mimeType: string, contents = id): PosterAsset => ({
  id,
  name: id,
  mimeType,
  blob: new Blob([contents]),
});
const bundle = (
  background = asset(DEFAULT_TEMPLATE.backgroundId, "image/png"),
  font = asset(DEFAULT_TEMPLATE.fontIds[0], "font/otf"),
): TemplateBundle => ({
  template: structuredClone(DEFAULT_TEMPLATE),
  assets: [background, font],
});
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
/** 预览绘制发生在 staging 画布上，目标画布只做一次 drawImage。 */
const drawnTexts = (
  canvases: { context: { fillText: { mock: { calls: { arguments: unknown[] }[] } } } }[],
) =>
  canvases.flatMap((canvas) =>
    canvas.context.fillText.mock.calls.map((call) => String(call.arguments[0])),
  );

test("同画布新请求立即取消旧请求，其他画布继续共享底图和字体", async (t) => {
  const { renderer, TestCanvas, images, fontLoads, createUrl, revokeUrl } = setupBrowser(t);
  const target = new TestCanvas();
  const other = new TestCanvas();
  const data = bundle();
  const first = renderer.draw(asCanvas(target), data, { job: "旧记录" }, { preview: true });
  const parallel = renderer.draw(asCanvas(other), data, {}, { preview: true });
  const replacement = renderer.draw(asCanvas(target), data, { job: "新记录" }, { preview: true });
  await assert.rejects(first, { code: "CANCELLED" });
  assert.equal(target.context.drawImage.mock.callCount(), 0);
  assert.equal(images.length, 1);
  images[0].onload?.();
  await Promise.all([parallel, replacement]);
  assert.equal(images[0].decodeCount, 1);
  assert.equal(fontLoads.length, 1);
  assert.equal(createUrl.mock.callCount(), 1);
  assert.equal(revokeUrl.mock.callCount(), 1);
  assert.equal(target.context.drawImage.mock.callCount(), 1);
  assert.equal(other.context.drawImage.mock.callCount(), 1);
});

test("不同 Blob 即使底图标识相同也分别解码，错误可重试且保留现有画面", async (t) => {
  const { renderer, TestCanvas, images } = setupBrowser(t);
  const target = new TestCanvas();
  const data = bundle();
  const original = renderer.draw(asCanvas(target), data, {}, { preview: true });
  images[0].onload?.();
  await original;
  const changed = bundle({ ...data.assets[0], blob: new Blob(["新底图"]) }, data.assets[1]);
  const rejected = renderer.draw(asCanvas(target), changed, {}, { preview: true });
  images[1].onerror?.();
  await assert.rejects(rejected, { code: "INVALID_ASSET" });
  assert.equal(target.context.drawImage.mock.callCount(), 1);
  const retry = renderer.draw(asCanvas(target), changed, {}, { preview: true });
  images[2].onload?.();
  await retry;
  assert.equal(target.context.drawImage.mock.callCount(), 2);
});

test("超大预览限尺寸、沿用原稿坐标与溢出判定，PNG 保留原尺寸且只创建一张画布", async (t) => {
  const { renderer, TestCanvas, images, canvases } = setupBrowser(t);
  const target = new TestCanvas();
  const data = bundle();
  data.template.width = 5000;
  data.template.height = 7000;
  const overflowValues = { job: "超".repeat(60) };
  const preview = renderer.draw(asCanvas(target), data, overflowValues, { preview: true });
  images[0].onload?.();
  assert.deepEqual((await preview).overflowBoxIds, ["job"]);
  assert.deepEqual([target.width, target.height], [1463, 2048]);
  assert.deepEqual(canvases[0].context.scale.mock.calls[0].arguments, [1463 / 5000, 2048 / 7000]);
  assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0]);
  await assert.rejects(renderer.png(data, overflowValues), { code: "TEXT_OVERFLOW" });
  assert.equal(canvases.length, 2);
  assert.equal(canvases[1].encode, undefined);
  const output = renderer.png(data, {});
  await nextTask();
  assert.equal(canvases.length, 3);
  assert.deepEqual(canvases[2].encodedSize, [5000, 7000]);
  const blob = new Blob(["PNG"], { type: "image/png" });
  canvases[2].encode?.(blob);
  assert.equal(await output, blob);
  assert.deepEqual([canvases[2].width, canvases[2].height], [0, 0]);
});

test("位图缓存按真实像素淘汰，释放渲染器取消解码和编码并注销字体", async (t) => {
  const { renderer, TestCanvas, images, canvases, fonts, revokeUrl } = setupBrowser(t);
  const target = new TestCanvas();
  const first = bundle();
  const second = bundle({ ...first.assets[0], blob: new Blob(["第二张"]) }, first.assets[1]);
  for (const data of [first, second, first]) {
    const draw = renderer.draw(asCanvas(target), data, {}, { preview: true });
    const image = images.at(-1)!;
    image.naturalWidth = image.naturalHeight = 5000;
    image.onload?.();
    await draw;
  }
  assert.equal(images.length, 3);
  assert.equal(fonts.size, 1);
  const encoding = renderer.png(first, {});
  await nextTask();
  const unfinished = renderer.draw(asCanvas(target), second, {}, { preview: true });
  assert.ok(canvases[3].encode);
  assert.equal(images.length, 4);
  renderer.dispose();
  await assert.rejects(encoding, { code: "CANCELLED" });
  await assert.rejects(unfinished, { code: "CANCELLED" });
  assert.equal(revokeUrl.mock.callCount(), 4);
  assert.equal(images[3].src, "");
  assert.equal(fonts.size, 0);
  assert.deepEqual([canvases[3].width, canvases[3].height], [0, 0]);
});

test("字体别名共享同一 Blob 的解码，文档内仅保留最近使用的字体", async (t) => {
  const { renderer, TestCanvas, images, fonts, fontLoads } = setupBrowser(t);
  const data = bundle();
  const originalFont = data.assets[1];
  const alias = { ...originalFont, id: "font-alias" };
  const extraFonts = Array.from({ length: 16 }, (_, index) => asset(`font-${index}`, "font/otf"));
  const allFonts = [originalFont, alias, ...extraFonts];
  data.assets = [data.assets[0], ...allFonts];
  data.template.fontIds = allFonts.map((font) => font.id);
  data.template.boxes = allFonts.map((font) => ({
    ...DEFAULT_TEMPLATE.boxes[0],
    id: font.id,
    fontId: font.id,
  }));
  const target = asCanvas(new TestCanvas());
  const draw = renderer.draw(target, data, {}, { preview: true });
  images[0].onload?.();
  await draw;
  assert.equal(fontLoads.length, 17);
  assert.equal(fonts.size, 16);
  await renderer.draw(target, data, {}, { preview: true });
  assert.equal(fontLoads.length, 17);
  assert.equal(fonts.size, 16);
});

test("跨表绑定按表维度取值，数据表字段不会被模板行文案覆盖", async (t) => {
  const { renderer, TestCanvas, images, canvases } = setupBrowser(t);
  const data = bundle();
  const base = DEFAULT_TEMPLATE.boxes[0];
  data.template.boxes = [
    { ...base, id: "tpl", fieldId: "shared", fieldTableId: "tpl-table" },
    { ...base, id: "data", fieldId: "shared", fieldTableId: null },
  ];
  const target = new TestCanvas();
  const draw = renderer.draw(
    asCanvas(target),
    data,
    { "tpl-table::shared": "模板行文案", shared: "数据行文案" },
    { preview: true },
  );
  images[0].onload?.();
  await draw;
  const texts = drawnTexts(canvases);
  assert.deepEqual(texts, ["模板行文案", "数据行文案"]);
});

test("模板行值缺失时回退固定文字，不会误用数据表同名字段", async (t) => {
  const { renderer, TestCanvas, images, canvases } = setupBrowser(t);
  const data = bundle();
  data.template.boxes = [
    { ...DEFAULT_TEMPLATE.boxes[0], id: "tpl", fieldId: "shared", fieldTableId: "tpl-table" },
  ];
  data.template.boxes[0].text = "固定文案";
  const target = new TestCanvas();
  const draw = renderer.draw(asCanvas(target), data, { shared: "数据行文案" }, { preview: true });
  images[0].onload?.();
  await draw;
  const texts = drawnTexts(canvases);
  assert.deepEqual(texts, ["固定文案"]);
});
