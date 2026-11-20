import { DEFAULT_TEMPLATE } from "../domain/defaults";
import { PosterError, type TemplateBundle, type PosterAsset } from "../domain/types";

export const PRESET_FONT = {
  id: "noto-bold",
  name: "NotoSansSC-Bold.woff2",
  /** 常用字子集：首屏先用它出图，完整字体到货后替换。 */
  fastName: "NotoSansSC-Bold-common.woff2",
  label: "Noto Sans SC · 粗体",
};

export const TITLE_PRESET_FONT = {
  id: "youshe-title",
  name: "优设标题黑.woff2",
  file: "YouSheBiaoTiHei.woff2",
  label: "优设标题黑",
};

let presetFont: Promise<PosterAsset> | undefined;
let presetFastFont: Promise<PosterAsset> | undefined;
let titleFont: Promise<PosterAsset> | undefined;
/** 已解析的完整字体；同一页面内再次加载时直接用它，不再退回子集。 */
let fullAsset: PosterAsset | undefined;
/** 子集字节的引用：用来识别画布上仍是预览字体。 */
let fastBlob: Blob | undefined;

/** 静态资源前缀：Vite 注入 BASE_URL，单元测试里退回根路径。 */
function assetUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  return `${base}${path}`;
}

async function fetchFontAsset(
  preset: Pick<PosterAsset, "id" | "name">,
  file = preset.name,
): Promise<PosterAsset> {
  try {
    const response = await fetch(assetUrl(`fonts/${file}`));
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size) return { id: preset.id, name: preset.name, mimeType: "font/woff2", blob };
    }
  } catch {
    // 网络异常与空文件使用相同的可重试错误。
  }
  throw new PosterError("FONT_LOAD_FAILED", `内置字体“${preset.name}”加载失败，请重试`);
}

/** 选用时才加载完整字体，重复选用复用请求。 */
export function loadTitlePresetFont(): Promise<PosterAsset> {
  titleFont ??= fetchFontAsset(TITLE_PRESET_FONT, TITLE_PRESET_FONT.file).catch((error) => {
    titleFont = undefined;
    throw error;
  });
  return titleFont;
}

/** 完整字体（全字符集 6.4 MB）：最终排版、保存和导出都用它。 */
function loadFullFont(): Promise<PosterAsset> {
  presetFont ??= fetchFontAsset(PRESET_FONT)
    .then((asset) => {
      fullAsset = asset;
      return asset;
    })
    .catch((error) => {
      presetFont = undefined;
      throw error;
    });
  return presetFont;
}

/**
 * 常用字子集（约 1.4 MB）：排版度量与完整字体同源，先用它把首屏画出来。
 * 子集缺字由画布字体串的 sans-serif 兜底，不会显示空白方块。
 */
function loadFastFont(): Promise<PosterAsset> {
  presetFastFont ??= fetchFontAsset(PRESET_FONT, PRESET_FONT.fastName)
    .then((asset) => {
      fastBlob = asset.blob;
      return asset;
    })
    .catch((error) => {
      presetFastFont = undefined;
      throw error;
    });
  return presetFastFont;
}

/** 建 bundle 时用：完整字体已到货就用完整字体，否则先用子集，到货后再替换。 */
function loadPresetAsset(): Promise<PosterAsset> {
  return fullAsset ? Promise.resolve(fullAsset) : loadFastFont().catch(loadFullFont);
}

/** 首屏就要用它排版：启动即发请求，与工作区配置读取并行，不排进后面的串行往返。 */
export function prefetchPresetFont(): void {
  // 先拉子集：和 6.4 MB 的完整字体同时下载会被抢走带宽，首屏反而更慢。
  // 子集到货（或失败）后再开始拉完整字体，两段下载互不干扰。
  void loadFastFont().then(
    () => void loadFullFont().catch(() => {}),
    () => void loadFullFont().catch(() => {}),
  );
}

function presetFontSubsetIndex(assets: PosterAsset[]): number {
  return fastBlob
    ? assets.findIndex((asset) => asset.id === PRESET_FONT.id && asset.blob === fastBlob)
    : -1;
}

export function hasPresetFontSubset(assets: PosterAsset[]): boolean {
  return presetFontSubsetIndex(assets) >= 0;
}

/**
 * 完整字体到货后把预览用的子集素材换掉；无需替换时返回原数组，避免多余重绘。
 * 画布因为 bundle 变化自动重绘一次，最终排版与全字符集完全一致。
 */
export function promotePresetFont(assets: PosterAsset[], full: PosterAsset): PosterAsset[] {
  const index = presetFontSubsetIndex(assets);
  if (index < 0) return assets;
  const next = [...assets];
  next[index] = { ...full, name: assets[index].name };
  return next;
}

/** 写回、导出、保存前调用：把预览用的子集字体换成完整字体。 */
export async function withCompletePresetFont(bundle: TemplateBundle): Promise<TemplateBundle> {
  if (!hasPresetFontSubset(bundle.assets)) return bundle;
  const full = await loadFullFont();
  const assets = promotePresetFont(bundle.assets, full);
  return assets === bundle.assets ? bundle : { ...bundle, assets };
}

export async function loadPresetFontUpgrade(): Promise<PosterAsset> {
  return loadFullFont();
}
async function fetchDemoBackground(): Promise<{ blob: Blob; name: string }> {
  // 优先下载体积更小的 WebP，下载失败或文件为空时回退 PNG。
  for (const candidate of [
    { file: "clean-background.webp", mimeType: "image/webp" },
    { file: "clean-background.png", mimeType: "image/png" },
  ]) {
    try {
      const response = await fetch(assetUrl(`demo/${candidate.file}`));
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size)
        return { blob: blob.slice(0, blob.size, candidate.mimeType), name: candidate.file };
    } catch {
      // 继续尝试下一个候选格式，失败原因由整体加载兜底。
    }
  }
  throw new Error("示例底图加载失败");
}

export async function loadDefaultBundle(): Promise<TemplateBundle> {
  const [background, font] = await Promise.all([fetchDemoBackground(), loadPresetAsset()]);
  return {
    template: structuredClone(DEFAULT_TEMPLATE),
    assets: [
      {
        id: DEFAULT_TEMPLATE.backgroundId,
        name: `清空内容的招聘底图${background.name.slice(background.name.lastIndexOf("."))}`,
        mimeType: background.blob.type || "image/webp",
        blob: background.blob,
      },
      font,
    ],
  };
}

/** 旧模板也能直接选用内置字体；保留原有字体和绑定，不替换用户已选字体。 */
export async function withPresetFonts(bundle: TemplateBundle): Promise<TemplateBundle> {
  let assets = bundle.assets;
  if (!assets.some((asset) => asset.id === PRESET_FONT.id)) {
    // 完整字体已到货就直接用；否则先用子集出图，到货后由 promotePresetFont 替换。
    assets = [...assets, await loadPresetAsset()];
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
