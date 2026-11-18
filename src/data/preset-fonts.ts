import { DEFAULT_TEMPLATE } from "../domain/defaults";
import type { TemplateBundle, PosterAsset } from "../domain/types";

export const PRESET_FONT = {
  id: "noto-bold",
  name: "NotoSansSC-Bold.woff2",
  label: "Noto Sans SC · 粗体",
};

let presetFont: Promise<PosterAsset> | undefined;

function loadPresetFont(): Promise<PosterAsset> {
  presetFont ??= fetch(`${import.meta.env.BASE_URL}fonts/${PRESET_FONT.name}`)
    .then(async (response) => {
      if (!response.ok) throw new Error("内置字体加载失败，请刷新重试");
      return {
        id: PRESET_FONT.id,
        name: PRESET_FONT.name,
        mimeType: "font/woff2",
        blob: await response.blob(),
      };
    })
    .catch((error) => {
      presetFont = undefined;
      throw error;
    });
  return presetFont;
}

export async function loadDefaultBundle(): Promise<TemplateBundle> {
  const [background, font] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}demo/clean-background.png`).then(async (response) => {
      if (!response.ok) throw new Error("示例底图加载失败");
      return response.blob();
    }),
    loadPresetFont(),
  ]);
  return {
    template: structuredClone(DEFAULT_TEMPLATE),
    assets: [
      {
        id: DEFAULT_TEMPLATE.backgroundId,
        name: "清空内容的招聘底图.png",
        mimeType: "image/png",
        blob: background,
      },
      font,
    ],
  };
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
