import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hashBlob } from "../src/data/assets";
import {
  PRESET_FONT,
  TITLE_PRESET_FONT,
  identifyPresetFont,
  loadDefaultBundle,
  loadPresetFontUpgrade,
  loadReferencedPresetFont,
  loadTitlePresetFont,
  prefetchPresetFont,
  promotePresetFont,
  reuseSavedPresetFont,
  withCompletePresetFont,
  withPresetFonts,
} from "../src/data/preset-fonts";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import type { PosterAsset, TemplateBundle } from "../src/domain/types";

const readFont = (file: string) =>
  new Blob([readFileSync(new URL(`../public/fonts/${file}`, import.meta.url))], {
    type: "font/woff2",
  });
const fullFont = readFont(PRESET_FONT.name);
const fullTitleFont = readFont(TITLE_PRESET_FONT.file);
const fontFingerprint = async (blob: Blob) => ({
  mimeType: blob.type,
  size: blob.size,
  hash: await hashBlob(blob),
});

const requests: string[] = [];
let titleFontResponse: Blob | undefined;
const originalFetch = globalThis.fetch;
const respond = (input: RequestInfo | URL) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith(PRESET_FONT.fastName)) return new Response("subset-bytes");
  if (url.endsWith(PRESET_FONT.name)) return new Response(fullFont);
  if (url.endsWith(TITLE_PRESET_FONT.file) && titleFontResponse)
    return new Response(titleFontResponse);
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
  assert.equal(full.blob.size, fullFont.size);
  const background = subset.assets[0];
  const upgraded = await withCompletePresetFont(subset);
  assert.equal(fontOf(upgraded).blob, full.blob);
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
  assert.equal(fontOf(bundle).blob.size, fullFont.size);
  assert.deepEqual(bundle.template.fontIds, [PRESET_FONT.id]);
  // 已有内置字体的模板不重复追加素材。
  const again = await withPresetFonts(bundle);
  assert.equal(again.assets.length, 1);
  t.diagnostic(`requests=${requests.length}`);
});

test("有模板行底图时直接建立默认版式，不请求示例底图", async () => {
  const before = requests.length;
  const background = {
    id: "source-background",
    name: "模板底图.webp",
    mimeType: "image/webp",
    blob: new Blob(["source-background"]),
  };
  const bundle = await loadDefaultBundle(Promise.resolve(background));
  assert.equal(bundle.template.backgroundId, background.id);
  assert.equal(bundle.assets[0], background);
  assert.equal(requests.length, before);
});

test("启动预取只发一次请求，重复调用复用缓存", async () => {
  const before = requests.filter((url) => url.endsWith(".woff2")).length;
  prefetchPresetFont();
  const after = requests.filter((url) => url.endsWith(".woff2")).length;
  assert.equal(after, before);
});

test("真实完整字体符合版本合同，子集和不匹配的清单不会被识别", async () => {
  const before = requests.length;
  const noto = await fontFingerprint(fullFont);
  const youshe = await fontFingerprint(fullTitleFont);
  assert.equal(identifyPresetFont(noto), "noto-bold-v1");
  assert.equal(identifyPresetFont(youshe), "youshe-title-v1");
  assert.equal(
    identifyPresetFont(await fontFingerprint(readFont(PRESET_FONT.fastName))),
    undefined,
  );
  assert.equal(identifyPresetFont({ ...noto, mimeType: "font/ttf" }), undefined);
  assert.equal(identifyPresetFont({ ...noto, size: noto.size - 1 }), undefined);
  assert.equal(await reuseSavedPresetFont({ ...noto, hash: youshe.hash }), undefined);
  assert.equal(requests.length, before);
});

test("优设标题黑验证失败时允许旧模板回退，重试成功后与引用共用同一份字体", async () => {
  assert.equal(requests.filter((url) => url.endsWith(TITLE_PRESET_FONT.file)).length, 0);
  const legacyAsset = {
    ...(await fontFingerprint(fullTitleFont)),
    id: "自定义素材 ID",
    name: "优设标题黑副本.woff2",
  };
  await assert.rejects(loadReferencedPresetFont("youshe-title-v1"), { code: "FONT_LOAD_FAILED" });
  // 字节数相同的损坏字体仍必须通过内容校验，旧模板应回退到原附件。
  titleFontResponse = new Blob([fullTitleFont.slice(0, -1), new Uint8Array([0xff])]);
  assert.notEqual(await hashBlob(titleFontResponse), legacyAsset.hash);
  assert.equal(await reuseSavedPresetFont(legacyAsset), undefined);
  titleFontResponse = fullTitleFont;
  const reference = loadReferencedPresetFont("youshe-title-v1");
  assert.equal(loadReferencedPresetFont("youshe-title-v1"), reference);
  const font = await loadTitlePresetFont();
  assert.equal(font.id, TITLE_PRESET_FONT.id);
  assert.equal(font.name, TITLE_PRESET_FONT.name);
  assert.equal(font.mimeType, "font/woff2");
  assert.equal(await reference, font.blob);
  assert.equal(await reuseSavedPresetFont(legacyAsset), font.blob);
  assert.equal(await loadTitlePresetFont(), font);
  assert.equal(requests.filter((url) => url.endsWith(TITLE_PRESET_FONT.file)).length, 3);
});

test("旧版 Noto 附件可按内容复用已下载的完整字体", async () => {
  const before = requests.length;
  const font = await loadPresetFontUpgrade();
  const legacyAsset = { ...(await fontFingerprint(fullFont)), id: "旧版 Noto 素材 ID" };
  assert.equal(await reuseSavedPresetFont(legacyAsset), font.blob);
  assert.equal(await loadReferencedPresetFont("noto-bold-v1"), font.blob);
  assert.equal(requests.length, before);
});
