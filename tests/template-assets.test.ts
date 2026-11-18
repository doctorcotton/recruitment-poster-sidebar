import assert from "node:assert/strict";
import test from "node:test";
import { pruneTemplateAssets } from "../src/domain/template-assets";
import { DEFAULT_TEMPLATE } from "../src/domain/defaults";

test("清理未引用旧底图但保留声明的可用字体", () => {
  const background = {
    id: DEFAULT_TEMPLATE.backgroundId,
    name: "背景",
    mimeType: "image/png",
    blob: new Blob(["bg"]),
  };
  const font = {
    id: DEFAULT_TEMPLATE.fontIds[0],
    name: "字体",
    mimeType: "font/otf",
    blob: new Blob(["font"]),
  };
  const old = {
    id: "old-background",
    name: "旧背景",
    mimeType: "image/png",
    blob: new Blob(["old"]),
  };
  const pruned = pruneTemplateAssets({
    template: DEFAULT_TEMPLATE,
    assets: [background, font, old],
  });
  assert.deepEqual(
    pruned.assets.map((asset) => asset.id),
    [background.id, font.id],
  );
});
