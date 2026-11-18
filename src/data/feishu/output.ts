import type { IAttachmentField } from "@lark-base-open/js-sdk";
import { PosterError } from "../../domain/types";
import { validatePng } from "../assets";
import { platformError } from "../errors";
import type { FeishuSdkFacade, SdkTable } from "./sdk";
import { attachmentVersion, FIELD_TYPES } from "./values";

export async function outputField(table: SdkTable, fieldId: string): Promise<IAttachmentField> {
  const fieldMeta = (await table.getFieldMetaList()).find((field) => field.id === fieldId);
  if (fieldMeta?.type !== FIELD_TYPES.attachment)
    throw new PosterError("INVALID_ASSET", "海报输出必须选择附件字段。");
  return table.getFieldById<IAttachmentField>(fieldId);
}

export async function readFeishuOutputVersion(
  sdk: FeishuSdkFacade,
  requestedTableId: string | undefined,
  recordId: string,
  fieldId: string,
): Promise<string> {
  const targetTableId = requestedTableId ?? (await sdk.base.getSelection()).tableId;
  if (!targetTableId) throw new PosterError("PLATFORM_ERROR", "没有可读取的当前表。");
  const table = await sdk.base.getTableById(targetTableId);
  const field = await outputField(table, fieldId);
  await table.getRecordById(recordId);
  return attachmentVersion(await field.getValue(recordId));
}

export async function writeFeishuPng(
  sdk: FeishuSdkFacade,
  requestedTableId: string | undefined,
  recordId: string,
  fieldId: string,
  file: File,
  expectedVersion?: string,
): Promise<void> {
  validatePng(file);
  const targetTableId = requestedTableId ?? (await sdk.base.getSelection()).tableId;
  if (!targetTableId) throw new PosterError("PLATFORM_ERROR", "没有可写入的当前表。");
  const table = await sdk.base.getTableById(targetTableId);
  const field = await outputField(table, fieldId);
  await table.getRecordById(recordId);
  if (expectedVersion !== undefined) {
    const actual = attachmentVersion(await field.getValue(recordId));
    if (actual !== expectedVersion)
      throw new PosterError("WRITE_CONFLICT", "输出附件已被其他操作修改，请核对当前附件后再重试。");
  }
  try {
    // 只替换选中的附件单元格，不提交整条记录，其他业务字段完全不动。
    if (!(await field.setValue(recordId, file)))
      throw new PosterError(
        "WRITE_OUTCOME_UNKNOWN",
        "飞书未确认 PNG 附件写入成功，请核对当前附件后再决定重试。",
      );
  } catch (error) {
    if (error instanceof PosterError && error.code === "WRITE_OUTCOME_UNKNOWN") throw error;
    const mapped = platformError(error, "写回 PNG 附件");
    throw new PosterError(
      "WRITE_OUTCOME_UNKNOWN",
      `${mapped.message} 写入结果未知，请核对当前附件后再决定重试。`,
    );
  }
}
