import {
  PosterError,
  type PosterAsset,
  type PosterRepository,
  type TemplateBundle,
  type WorkspaceContext,
} from "./types";

/** 只替换本次渲染的背景；保存的模板坐标与素材不受逐行图片影响。 */
export function withRecordBackground(bundle: TemplateBundle, asset: PosterAsset): TemplateBundle {
  return {
    template: { ...bundle.template, backgroundId: asset.id },
    assets: [
      ...bundle.assets.filter(
        (item) => item.id !== asset.id && item.id !== bundle.template.backgroundId,
      ),
      asset,
    ],
  };
}

export async function resolveRecordBundle(
  bundle: TemplateBundle,
  recordId: string,
  context: WorkspaceContext,
  source: Pick<PosterRepository, "loadBackground">,
): Promise<TemplateBundle> {
  const fieldId = bundle.template.backgroundFieldId;
  if (!fieldId) return bundle;
  const field = context.fields.find((field) => field.id === fieldId);
  if (!field || !["attachment", "lookup"].includes(field.kind))
    throw new PosterError("INVALID_ASSET", "请重新绑定有效的底图附件或查找引用字段");
  return withRecordBackground(
    bundle,
    await source.loadBackground(recordId, fieldId, context.tableId),
  );
}
