import { PosterError, type TemplateBundle } from "../../domain/types";
import { identifyPresetFont, type PresetFontKey } from "../preset-fonts";
import { validateTemplate } from "../validation";
import { cellText } from "./values";

interface SavedAssetMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
}

export interface SavedAttachment extends SavedAssetMetadata {
  token: string;
  preset?: never;
}

interface SavedPresetFont extends SavedAssetMetadata {
  preset: PresetFontKey;
  token?: never;
}

export type SavedAsset = SavedAttachment | SavedPresetFont;

export function isSavedAttachment(asset: SavedAsset): asset is SavedAttachment {
  return typeof asset.token === "string";
}

export interface SavedConfig {
  schemaVersion: 1 | 2;
  template: TemplateBundle["template"];
  assets: SavedAsset[];
  updatedAt: number;
}

export function buildSavedConfig(
  template: TemplateBundle["template"],
  assets: SavedAsset[],
  updatedAt: number,
): SavedConfig {
  // 仅在使用版本化字体引用时才写新版，纯附件清单继续兼容旧客户端。
  return {
    schemaVersion: assets.some((asset) => asset.preset) ? 2 : 1,
    template,
    assets,
    updatedAt,
  };
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
    (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
    !Array.isArray(parsed.assets) ||
    !Number.isFinite(parsed.updatedAt)
  ) {
    throw new PosterError("INVALID_TEMPLATE", "模板配置版本不受支持或结构不正确。");
  }
  validateTemplate(parsed.template);
  if (
    parsed.assets.some((asset) => {
      if (
        !asset ||
        typeof asset.id !== "string" ||
        typeof asset.name !== "string" ||
        typeof asset.mimeType !== "string" ||
        typeof asset.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(asset.hash) ||
        !Number.isFinite(asset.size) ||
        asset.size <= 0
      )
        return true;
      if (asset.preset === undefined) return !isSavedAttachment(asset) || !asset.token;
      return (
        parsed.schemaVersion !== 2 ||
        asset.token !== undefined ||
        !asset.preset ||
        identifyPresetFont(asset) !== asset.preset
      );
    })
  ) {
    throw new PosterError("INVALID_TEMPLATE", "模板素材清单不完整。");
  }
  return parsed;
}
