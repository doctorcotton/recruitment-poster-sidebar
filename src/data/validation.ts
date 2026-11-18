import { validateTemplate as validateDomainTemplate } from "../domain/validation";
import {
  PosterError,
  type PosterTemplate,
  type TemplateBundle,
  type WorkspaceBinding,
  type WorkspaceSettings,
} from "../domain/types";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 两种仓储共用绑定校验，只保留连接指针，额外字段不进入存储。 */
export function normalizeWorkspaceBinding(value: unknown): WorkspaceBinding {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.tableId !== "string" ||
    !value.tableId.trim() ||
    typeof value.storageTableId !== "string" ||
    !value.storageTableId.trim()
  ) {
    throw new PosterError("INVALID_TEMPLATE", "工作区绑定版本不受支持或业务表、配置表 ID 无效。");
  }
  return { schemaVersion: 1, tableId: value.tableId, storageTableId: value.storageTableId };
}
/** 仓储和渲染共用领域校验，避免保存了一套规则而绘制使用另一套。 */
export function validateTemplate(value: unknown): asserts value is PosterTemplate {
  validateDomainTemplate(value);
}

export function validateBundle(bundle: TemplateBundle): void {
  validateTemplate(bundle.template);
  const ids = new Set<string>();
  for (const asset of bundle.assets) {
    if (
      !asset.id ||
      ids.has(asset.id) ||
      !(asset.blob instanceof Blob) ||
      !asset.blob.size ||
      !asset.name ||
      !asset.mimeType
    ) {
      throw new PosterError("INVALID_ASSET", "模板素材为空、格式不正确或标识重复。");
    }
    ids.add(asset.id);
  }
  const required = [
    bundle.template.backgroundId,
    ...bundle.template.fontIds,
    ...bundle.template.boxes.map((box) => box.fontId),
  ];
  if (required.some((id) => !ids.has(id)))
    throw new PosterError("INVALID_ASSET", "模板缺少底图或字体素材。");
}

/** 配置只保留领域字段；模板已保存字段绑定，不在设置中复制第二份映射。 */
export function normalizeSettings(value: unknown, tableId?: string): WorkspaceSettings {
  const nullableId = (id: unknown) => id === null || (typeof id === "string" && id.length > 0);
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.tableId !== "string" ||
    !value.tableId ||
    (tableId !== undefined && value.tableId !== tableId) ||
    !nullableId(value.templateId) ||
    !nullableId(value.outputFieldId) ||
    (value.backgroundFieldId !== undefined && !nullableId(value.backgroundFieldId)) ||
    (value.updatedAt !== undefined &&
      (typeof value.updatedAt !== "number" ||
        !Number.isFinite(value.updatedAt) ||
        value.updatedAt <= 0))
  ) {
    throw new PosterError(
      "INVALID_TEMPLATE",
      "工作区配置格式不正确、版本不受支持或所属数据表不一致。",
    );
  }
  return {
    schemaVersion: 1,
    tableId: value.tableId,
    templateId: value.templateId as string | null,
    outputFieldId: value.outputFieldId as string | null,
    ...(value.backgroundFieldId !== undefined
      ? { backgroundFieldId: value.backgroundFieldId as string | null }
      : {}),
    ...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt as number } : {}),
  };
}
