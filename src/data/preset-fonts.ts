import { DEFAULT_TEMPLATE } from "../domain/defaults";
import { PosterError, type TemplateBundle, type PosterAsset } from "../domain/types";
import { hashBlob } from "./assets";
import { downloadAttachment } from "./background-attachment";

export const PRESET_FONT = {
  id: "noto-bold",
  /** 素材名沿用完整字体的文件名，已保存模板的配置不需要迁移。 */
  name: "NotoSansSC-Bold.woff2",
  /** 实际加载的是 GB2312 常用字子集，完整字库不进仓库。 */
  file: "NotoSansSC-Bold-common.woff2",
  label: "Noto Sans SC · 粗体",
};

export const TITLE_PRESET_FONT = {
  id: "youshe-title",
  name: "优设标题黑.woff2",
  file: "YouSheBiaoTiHei.woff2",
  label: "优设标题黑",
};

export type PresetFontKey = "noto-bold-v1" | "youshe-title-v1";

type FontFingerprint = { mimeType: string; size: number; hash: string };

// 引用键对应固定的内置字体字节，替换文件时应使用新的版本键。
const presetFingerprints: Record<PresetFontKey, FontFingerprint> = {
  "noto-bold-v1": {
    mimeType: "font/woff2",
    size: 1488080,
    hash: "03baa381bb5225fda99d1f25a813832569792787b83d1d12348d273859e025a5",
  },
  "youshe-title-v1": {
    mimeType: "font/woff2",
    size: 631092,
    hash: "3aebc5860c0b4eac166e5ee4b882a96859a88dfabe945edb8fc056e155c3d5f6",
  },
};

let presetFont: Promise<PosterAsset> | undefined;
let titleFont: Promise<PosterAsset> | undefined;
const verifiedFonts = new Map<PresetFontKey, Promise<Blob>>();

/** 静态资源前缀：Vite 注入 BASE_URL，单元测试里退回根路径。 */
function assetUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  return `${base}${path}`;
}

async function fetchFontAsset(
  preset: Pick<PosterAsset, "id" | "name">,
  file: string,
): Promise<PosterAsset> {
  try {
    const mimeType = "font/woff2";
    const bytes = await downloadAttachment(assetUrl(`fonts/${file}`));
    return {
      id: preset.id,
      name: preset.name,
      mimeType,
      blob: bytes.slice(0, bytes.size, mimeType),
    };
  } catch {
    // 网络异常与空文件使用相同的可重试错误。
  }
  throw new PosterError("FONT_LOAD_FAILED", `内置字体“${preset.name}”加载失败，请重试`);
}

/** 选用时才加载优设标题黑，重复选用复用请求。 */
export function loadTitlePresetFont(): Promise<PosterAsset> {
  titleFont ??= fetchFontAsset(TITLE_PRESET_FONT, TITLE_PRESET_FONT.file).catch((error) => {
    titleFont = undefined;
    throw error;
  });
  return titleFont;
}

/**
 * 内置 Noto 字体（GB2312 常用字子集）：排版、保存、导出都用同一份字节。
 * 子集之外的生僻字由画布字体串的 sans-serif 兜底，不会显示空白方块。
 */
function loadPresetFont(): Promise<PosterAsset> {
  presetFont ??= fetchFontAsset(PRESET_FONT, PRESET_FONT.file).catch((error) => {
    presetFont = undefined;
    throw error;
  });
  return presetFont;
}

/** 按字体内容识别，素材名和 ID 可随模板变化。 */
export function identifyPresetFont(asset: FontFingerprint): PresetFontKey | undefined {
  for (const [key, preset] of Object.entries(presetFingerprints)) {
    if (
      asset.mimeType === preset.mimeType &&
      asset.size === preset.size &&
      asset.hash === preset.hash
    )
      return key as PresetFontKey;
  }
}

async function verifyReferencedFont(key: PresetFontKey): Promise<Blob> {
  const isNoto = key === "noto-bold-v1";
  const { name, blob } = await (isNoto ? loadPresetFont() : loadTitlePresetFont());
  const { size, hash } = presetFingerprints[key];
  try {
    if (blob.size === size && (await hashBlob(blob)) === hash) return blob;
  } catch {
    // 读取字体字节失败也按内置字体加载失败处理。
  }
  // 清除未通过校验的静态资源缓存，允许后续重试。
  if (isNoto) presetFont = undefined;
  else titleFont = undefined;
  throw new PosterError("FONT_LOAD_FAILED", `内置字体“${name}”校验失败，请重试`);
}

export function loadReferencedPresetFont(key: PresetFontKey): Promise<Blob> {
  let verified = verifiedFonts.get(key);
  if (!verified) {
    verified = verifyReferencedFont(key).catch((error) => {
      verifiedFonts.delete(key);
      throw error;
    });
    verifiedFonts.set(key, verified);
  }
  return verified;
}

/** 只有内置字体的字节与保存清单一致时，才能替代飞书附件。 */
export async function reuseSavedPresetFont(asset: FontFingerprint): Promise<Blob | undefined> {
  const key = identifyPresetFont(asset);
  if (!key) return;
  try {
    return await loadReferencedPresetFont(key);
  } catch {
    // 内置版本不可用时，继续读取模板原先保存的飞书附件。
  }
}

/** 首屏就要用它排版：启动即发请求，与工作区配置读取并行，不排进后面的串行往返。 */
export function prefetchPresetFont(): void {
  void loadPresetFont().catch(() => {});
}

async function fetchDemoBackground(): Promise<{ blob: Blob; name: string }> {
  const file = "clean-background.webp";
  try {
    const response = await fetch(assetUrl(`demo/${file}`));
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size) return { blob: blob.slice(0, blob.size, "image/webp"), name: file };
    }
  } catch {
    // 统一走下面的整体失败提示。
  }
  throw new Error("示例底图加载失败");
}

export async function loadDefaultBundle(
  sourceBackground?: Promise<PosterAsset | null>,
): Promise<TemplateBundle> {
  const loadBackground = async (): Promise<PosterAsset> => {
    const source = await sourceBackground;
    if (source) return source;
    const demo = await fetchDemoBackground();
    return {
      id: DEFAULT_TEMPLATE.backgroundId,
      name: `清空内容的招聘底图${demo.name.slice(demo.name.lastIndexOf("."))}`,
      mimeType: demo.blob.type || "image/webp",
      blob: demo.blob,
    };
  };
  const [background, font] = await Promise.all([loadBackground(), loadPresetFont()]);
  const template = structuredClone(DEFAULT_TEMPLATE);
  template.backgroundId = background.id;
  return { template, assets: [background, font] };
}

/** 旧模板也能直接选用内置字体；保留原有字体和绑定，不替换用户已选字体。 */
export async function withPresetFonts(bundle: TemplateBundle): Promise<TemplateBundle> {
  let assets = bundle.assets;
  if (!assets.some((asset) => asset.id === PRESET_FONT.id)) {
    assets = [...assets, await loadPresetFont()];
  }
  return {
    ...bundle,
    assets,
    template: {
      ...bundle.template,
      fontIds: Array.from(new Set([PRESET_FONT.id, ...bundle.template.fontIds])),
    },
  };
}
