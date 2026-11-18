import type { TemplateBundle } from "./types";

/** 清理当前模板不再引用的旧底图；fontIds 是用户可用字体列表，必须全部保留。 */
export function pruneTemplateAssets(bundle: TemplateBundle): TemplateBundle {
  const required = new Set([
    bundle.template.backgroundId,
    ...bundle.template.fontIds,
    ...bundle.template.boxes.map((box) => box.fontId),
  ]);
  return { ...bundle, assets: bundle.assets.filter((asset) => required.has(asset.id)) };
}
