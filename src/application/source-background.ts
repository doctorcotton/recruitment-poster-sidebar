import { pruneTemplateAssets } from "../domain/template-assets";
import type { PosterRepository, TemplateBundle, TemplateSource } from "../domain/types";

/** 底图替换结果；失败时保留草稿原有底图，只把原因交给界面提示。 */
export interface SourceBackgroundResult {
  bundle: TemplateBundle;
  warning: string;
}

/**
 * 未保存配置的模板行没有可恢复的版式，但底图同样来自模板行的附件字段。
 * 用真实底图替换示例底图，并剔除不再被引用的旧图，避免保存时把示例图写进模板行。
 */
export async function withSourceBackground(
  repository: PosterRepository,
  draft: TemplateBundle,
  source: TemplateSource,
): Promise<SourceBackgroundResult> {
  try {
    const background = await repository.loadSourceBackground(source);
    const replaced = {
      ...draft,
      template: { ...draft.template, backgroundId: background.id },
      assets: [
        ...draft.assets.filter((asset) => asset.id !== draft.template.backgroundId),
        background,
      ],
    };
    return { bundle: pruneTemplateAssets(replaced), warning: "" };
  } catch (error) {
    return {
      bundle: draft,
      warning: error instanceof Error ? error.message : "模板底图读取失败",
    };
  }
}
