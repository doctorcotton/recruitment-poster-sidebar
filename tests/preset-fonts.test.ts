import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESET_FONT,
  TITLE_PRESET_FONT,
  loadDefaultBundle,
  loadPresetFontUpgrade,
  loadTitlePresetFont,
  prefetchPresetFont,
  promotePresetFont,
  withCompletePresetFont,
  withPresetFonts,
} from "../src/data/preset-fonts";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { PosterAsset, TemplateBundle } from "../src/domain/types";

const requests: string[] = [];
let titleFontAvailable = false;
const originalFetch = globalThis.fetch;
const respond = (input: RequestInfo | URL) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith(PRESET_FONT.fastName)) return new Response("subset-bytes");
  if (url.endsWith(PRESET_FONT.name)) return new Response("full-bytes");
  if (url.endsWith(TITLE_PRESET_FONT.file) && titleFontAvailable)
    return new Response("title-font-bytes");
  if (url.endsWith("clean-background.webp")) return new Response("webp-bytes");
  if (url.endsWith("clean-background.png")) return new Response("png-bytes");
  return new Response("missing", { status: 404 });
};
globalThis.fetch = (async (input: RequestInfo | URL) => respond(input)) as typeof fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

const fontOf = (bundle: TemplateBundle) =>
  bundle.assets.find((asset) => asset.id === PRESET_FONT.id) as PosterAsset;

test("自带完整字体的模板可直接交付，无需请求内置字体", async () => {
  const bundle = {
    template: structuredClone(DEFAULT_TEMPLATE),
    assets: [
      {
        id: PRESET_FONT.id,
        name: "custom.woff2",
        mimeType: "font/woff2",
        blob: new Blob(["custom-font"]),
      },
    ],
  };
  assert.equal(await withCompletePresetFont(bundle), bundle);
  assert.deepEqual(requests, []);
});

test("全新打开先用常用字子集出图，字体标识仍是内置字体", async () => {
  const bundle = await loadDefaultBundle();
  const font = fontOf(bundle);
  assert.equal(await font.blob.text(), "subset-bytes");
  // 素材名固定为完整字体文件名，保存后的模板配置不会出现“子集”字样。
  assert.equal(font.name, PRESET_FONT.name);
  assert.equal(font.mimeType, "font/woff2");
  assert.equal(bundle.assets[0].mimeType, "image/webp");
  assert.ok(requests.some((url) => url.endsWith(PRESET_FONT.fastName)));
});

test("完整字体到货后替换子集素材，名称与其余素材保持不变", async () => {
  const subset = await loadDefaultBundle();
  assert.equal(await fontOf(subset).blob.text(), "subset-bytes");
  const full = await loadPresetFontUpgrade();
  assert.equal(await full.blob.text(), "full-bytes");
  const background = subset.assets[0];
  const upgraded = await withCompletePresetFont(subset);
  assert.equal(await fontOf(upgraded).blob.text(), "full-bytes");
  assert.equal(fontOf(upgraded).name, PRESET_FONT.name);
  assert.equal(upgraded.assets[0], background);
  // 幂等：已经是完整字体时返回同一个 bundle 对象，不触发多余重绘。
  assert.equal(await withCompletePresetFont(upgraded), upgraded);
  // 没有内置字体的素材表原样返回同一个数组。
  const onlyBackground = [background];
  assert.equal(promotePresetFont(onlyBackground, full), onlyBackground);
  // 内置字体 id 下但不是子集字节（用户自备字体）时同样不动。
  const customFont = { ...full, blob: new Blob(["custom-font"]) };
  const mixed = [customFont];
  assert.equal(promotePresetFont(mixed, full), mixed);
});

test("完整字体已到货后新模板直接挂完整字体", async (t) => {
  const bundle = await withPresetFonts({
    template: structuredClone(DEFAULT_TEMPLATE),
    assets: [],
  });
  assert.equal(await fontOf(bundle).blob.text(), "full-bytes");
  assert.deepEqual(bundle.template.fontIds, [PRESET_FONT.id]);
  // 已有内置字体的模板不重复追加素材。
  const again = await withPresetFonts(bundle);
  assert.equal(again.assets.length, 1);
  t.diagnostic(`requests=${requests.length}`);
});

test("启动预取只发一次请求，重复调用复用缓存", async () => {
  const before = requests.filter((url) => url.endsWith(".woff2")).length;
  prefetchPresetFont();
  const after = requests.filter((url) => url.endsWith(".woff2")).length;
  assert.equal(after, before);
});

test("优设标题黑按需加载，失败后可重试并复用成功结果", async () => {
  assert.equal(requests.filter((url) => url.endsWith(TITLE_PRESET_FONT.file)).length, 0);
  await assert.rejects(loadTitlePresetFont(), { code: "FONT_LOAD_FAILED" });
  titleFontAvailable = true;
  const font = await loadTitlePresetFont();
  assert.equal(font.id, TITLE_PRESET_FONT.id);
  assert.equal(font.name, TITLE_PRESET_FONT.name);
  assert.equal(font.mimeType, "font/woff2");
  assert.equal(await font.blob.text(), "title-font-bytes");
  assert.equal(await loadTitlePresetFont(), font);
  assert.equal(requests.filter((url) => url.endsWith(TITLE_PRESET_FONT.file)).length, 2);
});
