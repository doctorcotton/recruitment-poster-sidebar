import { PosterError, type TemplateBundle } from "../../domain/types";
import { validateTemplate } from "../validation";
import { cellText } from "./values";

export interface SavedAsset {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  token: string;
  hash: string;
}
export interface SavedConfig {
  schemaVersion: 1;
  template: TemplateBundle["template"];
  assets: SavedAsset[];
  updatedAt: number;
}

export function parseConfig(value: unknown): SavedConfig {
  let parsed: SavedConfig;
  try {
    parsed = JSON.parse(cellText(value)) as SavedConfig;
  } catch {
    throw new PosterError("INVALID_TEMPLATE", "模板配置不是有效 JSON。");
  }
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.assets) ||
    !Number.isFinite(parsed.updatedAt)
  ) {
    throw new PosterError("INVALID_TEMPLATE", "模板配置版本不受支持或结构不正确。");
  }
  validateTemplate(parsed.template);
  if (
    parsed.assets.some(
      (asset) =>
        !asset ||
        typeof asset.id !== "string" ||
        typeof asset.name !== "string" ||
        typeof asset.mimeType !== "string" ||
        typeof asset.token !== "string" ||
        !asset.token ||
        typeof asset.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(asset.hash) ||
        !Number.isFinite(asset.size) ||
        asset.size <= 0,
    )
  ) {
    throw new PosterError("INVALID_TEMPLATE", "模板素材清单不完整。");
  }
  return parsed;
}
