import assert from "node:assert/strict";
import test from "node:test";
import { withSourceBackground } from "../src/application/source-background";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";
import {
  PosterError,
  type PosterAsset,
  type PosterRepository,
  type TemplateBundle,
  type TemplateSource,
} from "../src/domain/types";

const source: TemplateSource = {
  tableId: "template",
  tableName: "模板表",
  recordId: "s1",
  recordName: "正编业代",
  backgroundFieldId: "image",
};

function repositoryOf(load: () => Promise<PosterAsset>): PosterRepository {
  return { loadSourceBackground: load } as unknown as PosterRepository;
}

/** 未保存配置的模板行以示例版式为草稿，底图仍是内置示例图。 */
function draft(): TemplateBundle {
  return {
    template: structuredClone(DEFAULT_TEMPLATE),
    assets: [
      {
        id: DEFAULT_TEMPLATE.backgroundId,
        name: "清空内容的招聘底图.png",
        mimeType: "image/png",
        blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      },
      {
        id: "noto-bold",
        name: "NotoSansSC-Bold.woff2",
        mimeType: "font/woff2",
        blob: new Blob([new Uint8Array([2])], { type: "font/woff2" }),
      },
    ],
  };
}

test("未配置模板行用附件底图替换示例底图，并剔除不再引用的旧图", async () => {
  const real: PosterAsset = {
    id: "asset-real",
    name: "正编业代底图.png",
    mimeType: "image/png",
    blob: new Blob([new Uint8Array([9])], { type: "image/png" }),
  };
  const result = await withSourceBackground(
    repositoryOf(async () => real),
    draft(),
    source,
  );
  assert.equal(result.warning, "");
  assert.equal(result.bundle.template.backgroundId, "asset-real");
  assert.deepEqual(result.bundle.assets.map((asset) => asset.id).sort(), [
    "asset-real",
    "noto-bold",
  ]);
  assert.deepEqual(result.bundle.template.fontIds, ["noto-bold"]);
});

test("底图读取失败时保留草稿版式，只把原因交给界面提示", async () => {
  const original = draft();
  const result = await withSourceBackground(
    repositoryOf(async () => {
      throw new PosterError("INVALID_ASSET", "当前行底图附件为空，请添加一张 PNG 或 JPEG 图片。");
    }),
    original,
    source,
  );
  assert.equal(result.bundle, original);
  assert.equal(result.warning, "当前行底图附件为空，请添加一张 PNG 或 JPEG 图片。");
});
