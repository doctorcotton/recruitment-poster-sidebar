import { PosterError, type DataRecord, type RecordPage, type TableField } from "../../domain/types";
import { recordPages } from "../../domain/record-pages";
import type { SdkFieldMeta, SdkRecord, SdkTable } from "./sdk";
import { cellText, FIELD_TYPES, fieldKind } from "./values";

export function formatRecordDisplayValue(value: unknown, field: TableField): string {
  if (field.kind === "attachment") {
    if (!Array.isArray(value) || !value.length) return "";
    const names = value.map((item) => cellText(item)).filter(Boolean);
    return names.length ? names.join("、") : `${value.length} 个附件`;
  }
  if (field.kind === "lookup" && Array.isArray(value)) {
    return value
      .map((item) => cellText(item))
      .filter(Boolean)
      .join("、");
  }
  return cellText(value, field.kind);
}

/** 查找引用的引用表只从 property 取，缺元数据时不伪造表标识。 */
function lookupTableId(field: SdkFieldMeta): string | undefined {
  if (field.type !== FIELD_TYPES.lookup) return undefined;
  const property = field.property as { refTableId?: unknown } | undefined;
  return typeof property?.refTableId === "string" && property.refTableId
    ? property.refTableId
    : undefined;
}

export function toTableField(field: SdkFieldMeta): TableField {
  const refTableId = lookupTableId(field);
  return {
    id: field.id,
    name: field.name,
    kind: fieldKind(field.type),
    isPrimary: field.isPrimary,
    ...(refTableId ? { refTableId } : {}),
  };
}

/** 记录名称只取主字段；旧元数据缺少标识时才回退到首个可展示的非空字段。 */
export function recordLabel(record: { fields: SdkRecord["fields"] }, fields: TableField[]): string {
  const primary = fields.find((field) => field.isPrimary);
  const candidates = primary
    ? [primary]
    : fields.filter((field) => field.kind !== "attachment" && field.kind !== "lookup");
  return (
    candidates.map((field) => cellText(record.fields[field.id], field.kind)).find(Boolean) ??
    "未命名记录"
  );
}

export function toDataRecord(record: SdkRecord, fields: TableField[]): DataRecord {
  const values: Record<string, string> = {};
  const displayValues: Record<string, string> = {};
  for (const field of fields) {
    displayValues[field.id] = formatRecordDisplayValue(record.fields[field.id], field);
    if (field.kind !== "attachment") values[field.id] = displayValues[field.id];
  }
  return {
    id: record.recordId,
    label: recordLabel(record, fields),
    values,
    displayValues,
  };
}

export async function readRecordPage(
  table: SdkTable,
  fields: TableField[],
  pageToken?: number,
  pageSize = 50,
  viewId?: string,
): Promise<RecordPage> {
  const result = await table.getRecordsByPage({
    pageSize,
    // 视图 ID 让平台按视图的排序与筛选返回记录，列表顺序才与用户看到的表格一致。
    ...(viewId ? { viewId } : {}),
    ...(pageToken !== undefined ? { pageToken } : {}),
  });
  return {
    records: result.records.map((record) => toDataRecord(record, fields)),
    hasMore: result.hasMore,
    pageToken: result.hasMore ? nextPageToken(result.pageToken, pageToken) : undefined,
    total: result.total,
  };
}

function nextPageToken(next: number | undefined, current?: number): number {
  if (next === undefined || !Number.isSafeInteger(next) || next < 0 || next === (current ?? 0))
    throw new PosterError("PLATFORM_ERROR", "飞书返回无效的分页标记。");
  return next;
}

export async function readAllRecords(table: SdkTable, viewId?: string): Promise<SdkRecord[]> {
  const records: SdkRecord[] = [];
  for await (const page of recordPages((pageToken) =>
    table.getRecordsByPage({
      pageSize: 200,
      ...(viewId ? { viewId } : {}),
      ...(pageToken !== undefined ? { pageToken } : {}),
    }),
  )) {
    records.push(...page.records);
  }
  return records;
}
